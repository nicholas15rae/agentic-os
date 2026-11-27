#!/usr/bin/env python3
"""Agentic OS — Event-Driven Scheduler Engine

File watcher + cron-based scheduler with execution history.
Handles job reloading, webhook triggers, skill execution events.
"""
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Callable

try:  # inter-process lock on the history file (Windows / POSIX)
    import msvcrt
    fcntl = None
except ImportError:  # pragma: no cover - POSIX
    msvcrt = None
    import fcntl

BASE_DIR = Path(__file__).parent.resolve()
JOBS_DIR = BASE_DIR / "jobs"
HISTORY_FILE = BASE_DIR.parent / "data" / "scheduler-history.json"
HISTORY_LIMIT = 1000
HISTORY_LOCK_TIMEOUT = 10.0  # seconds to wait for another process holding the history lock

log = logging.getLogger("agentic_os.scheduler")

_event_listeners = []
_on_files_changed = []
# APScheduler runs jobs on a thread pool, so two jobs due in the same minute (Heartbeat */5 and
# Daily Standup at 09:00) save at the same instant. Every history read-modify-write holds this.
_history_lock = threading.Lock()

def on_event(listener: Callable):
    _event_listeners.append(listener)
    return listener

def on_files_changed(cb: Callable):
    _on_files_changed.append(cb)
    return cb

def emit_event(event: dict):
    event["timestamp"] = datetime.now(timezone.utc).isoformat()
    event["id"] = str(uuid.uuid4())[:8]
    for listener in _event_listeners:
        try:
            listener(event)
        except Exception:
            pass
    # History is a record, not the action: failing to save it must not abort the job or request
    # that emitted the event (run_skill, the webhook routes, manual triggers).
    try:
        _save_history(event)
    except Exception as exc:
        log.warning("scheduler: event %s not saved to history: %s", event["id"], exc)


# ─── Event History (data/scheduler-history.json) ──────────────
# Saves were a plain read → append → Path.write_text. Two threads saving at once both read the same
# list, then both opened the file with truncation and wrote from byte 0: the shorter write landed
# over the longer one and left its last bytes ("}\r\n]") behind, so every later load failed with
# "Extra data". Now every save holds a thread + file lock and swaps a complete temp file into place.

@contextmanager
def _history_guard():
    """Serialise history access across this process's threads and any other process."""
    with _history_lock:
        lock_path = HISTORY_FILE.with_name(HISTORY_FILE.name + ".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with open(lock_path, "a+b") as fh:
            _lock_file(fh)
            try:
                yield
            finally:
                _unlock_file(fh)


def _lock_file(fh) -> None:
    deadline = time.monotonic() + HISTORY_LOCK_TIMEOUT
    while True:
        try:
            if msvcrt:
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except OSError:
            if time.monotonic() >= deadline:
                raise TimeoutError(f"history lock {fh.name} still held after {HISTORY_LOCK_TIMEOUT:.0f}s")
            time.sleep(0.01)


def _unlock_file(fh) -> None:
    try:
        if msvcrt:
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass  # closing the handle releases the lock anyway


def _write_history(history: list) -> None:
    """Write the whole list to a temp file beside HISTORY_FILE, then swap it into place."""
    HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(history, indent=2, default=str).encode("utf-8")
    fd, tmp = tempfile.mkstemp(prefix=HISTORY_FILE.name + ".", suffix=".tmp", dir=HISTORY_FILE.parent)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        for attempt in range(20):
            try:
                os.replace(tmp, HISTORY_FILE)
                return
            except PermissionError:
                # Windows refuses the swap while another program (an editor, the indexer,
                # antivirus) has the file open. Wait briefly and try again.
                if attempt == 19:
                    raise
                time.sleep(0.05)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_history() -> list:
    """Load the history. A corrupt file is kept aside and replaced (see _recover_history)."""
    try:
        raw = HISTORY_FILE.read_bytes()
    except FileNotFoundError:
        return []
    if not raw.strip():
        return []
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError as exc:  # JSONDecodeError and UnicodeDecodeError
        return _recover_history(raw, str(exc))
    if not isinstance(data, list):
        return _recover_history(raw, f"top level is {type(data).__name__}, not a list")
    return data


def _salvage(raw: bytes) -> list:
    """Events from a complete JSON list at the start of a corrupt file, else []."""
    try:
        data, _ = json.JSONDecoder().raw_decode(raw.decode("utf-8", "replace").lstrip())
    except ValueError:
        return []
    if not isinstance(data, list):
        return []
    return [e for e in data if isinstance(e, dict)][-HISTORY_LIMIT:]


def _recover_history(raw: bytes, reason: str) -> list:
    """Keep a copy of the unreadable file, then replace it with whatever events survive.

    Runs under _history_guard. The copy is written before the original is replaced, so the bad
    bytes are never lost; after the replace the file is valid, so this logs once per incident.
    """
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    keep = HISTORY_FILE.with_name(f"{HISTORY_FILE.stem}.corrupt-{stamp}{HISTORY_FILE.suffix}")
    n = 1
    while keep.exists():
        keep = HISTORY_FILE.with_name(f"{HISTORY_FILE.stem}.corrupt-{stamp}-{n}{HISTORY_FILE.suffix}")
        n += 1
    keep.write_bytes(raw)
    history = _salvage(raw)
    _write_history(history)
    log.warning(
        "scheduler: %s was unreadable (%s). Kept a copy at %s and restarted the history with "
        "the %d events that could be salvaged.", HISTORY_FILE.name, reason, keep.name, len(history),
    )
    return history


def _save_history(event: dict):
    with _history_guard():
        history = _read_history()
        history.append(event)
        if len(history) > HISTORY_LIMIT:
            history = history[-HISTORY_LIMIT:]
        _write_history(history)

def get_history(limit: int = 100) -> list:
    with _history_guard():
        history = _read_history()
    return history[-limit:]

def load_job_definitions() -> list:
    jobs = []
    for f in sorted(JOBS_DIR.glob("*.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        data["_file"] = str(f)
        jobs.append(data)
    return jobs

def get_job_by_id(job_id: str) -> Optional[dict]:
    for job in load_job_definitions():
        if job.get("id") == job_id:
            return job
    return None

def get_job_by_name(name: str) -> Optional[dict]:
    for job in load_job_definitions():
        if job.get("name") == name:
            return job
    return None

def run_skill(skill_name: str, trigger: str = "scheduler", input_text: str = ""):
    """Execute a skill via the API."""
    audit_file = BASE_DIR.parent / "audit" / "audit.log"
    timestamp = datetime.now(timezone.utc).isoformat()
    entry = {
        "action": "scheduler_run",
        "skill": skill_name,
        "trigger": trigger,
        "timestamp": timestamp,
    }
    with open(audit_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
    emit_event({
        "type": "skill_run",
        "skill": skill_name,
        "trigger": trigger,
        "status": "started",
    })
    print(f"[{timestamp}] Skill '{skill_name}' triggered by {trigger}")
    return {"status": "triggered", "skill": skill_name, "trigger": trigger}


# ─── File Watcher ─────────────────────────────────────────────

class JobFileWatcher:
    """Watch scheduler/jobs/ for changes and notify listeners."""
    def __init__(self, interval: float = 2.0):
        self.interval = interval
        self._known = {}
        self._running = False
        self._thread = None

    def start(self):
        self._running = True
        self._scan()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False

    def _scan(self):
        current = {}
        for f in JOBS_DIR.glob("*.json"):
            try:
                mtime = f.stat().st_mtime
                current[str(f)] = mtime
            except OSError:
                pass
        if self._known and current != self._known:
            for cb in _on_files_changed:
                try:
                    cb()
                except Exception:
                    pass
        self._known = current

    def _loop(self):
        while self._running:
            time.sleep(self.interval)
            self._scan()


# ─── Cron Scheduler ────────────────────────────────────────────

class CronScheduler:
    """Simple in-process cron scheduler using APScheduler."""
    def __init__(self):
        self._scheduler = None
        self._watcher = JobFileWatcher()

    def start(self):
        try:
            from apscheduler.schedulers.background import BackgroundScheduler as BS
            from apscheduler.triggers.cron import CronTrigger as CT
        except ImportError:
            print("APScheduler not found — auto-installing...")
            try:
                subprocess.check_call(
                    [sys.executable, "-m", "pip", "install", "apscheduler", "--quiet"]
                )
                from apscheduler.schedulers.background import BackgroundScheduler as BS
                from apscheduler.triggers.cron import CronTrigger as CT
            except Exception as e:
                print(f"Auto-install failed ({e}). Run: pip install apscheduler")
                return
        self._scheduler = BS()
        self._reload_jobs()
        self._scheduler.start()
        self._watcher.start()
        _on_files_changed.append(self._reload_jobs)
        print(f"Agentic OS Scheduler running. Jobs loaded from: {JOBS_DIR}")

    def stop(self):
        self._watcher.stop()
        if self._scheduler:
            self._scheduler.shutdown(wait=False)

    def _reload_jobs(self):
        if not self._scheduler:
            return
        from apscheduler.triggers.cron import CronTrigger as CT
        for job in self._scheduler.get_jobs():
            job.remove()
        for data in load_job_definitions():
            if not data.get("enabled", True):
                continue
            try:
                self._scheduler.add_job(
                    run_skill,
                    CT.from_crontab(data["cron"]),
                    args=[data["skill"], "cron"],
                    id=data.get("id", data["name"]),
                    name=data["name"],
                    replace_existing=True,
                    misfire_grace_time=60,
                )
            except Exception as e:
                print(f"  Failed to schedule {data.get('name')}: {e}")
        count = len(self._scheduler.get_jobs())
        print(f"  Scheduled {count} jobs")


# ─── Standalone Entry ─────────────────────────────────────────

def main():
    scheduler = CronScheduler()
    scheduler.start()
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        scheduler.stop()
        print("Scheduler stopped.")

if __name__ == "__main__":
    main()
