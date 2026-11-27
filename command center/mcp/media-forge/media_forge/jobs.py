"""Background jobs, so long renders never hit the gateway's 600 s per-call cap.

A heavy tool starts a job and waits up to `wait_s` for it. If it finishes in time the
result comes back inline; otherwise the caller gets a job id and polls `job_status`.
Job records are mirrored to <media_root>/.media-forge/jobs/<id>.json so status survives
a server restart (a job that was running when the server died reads "interrupted").

Child processes inherit the gateway's kill-on-close Job Object, so they die with the app.
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import threading
import time
import traceback
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable

from .config import PolicyError, Settings


@dataclass
class Job:
    id: str
    kind: str
    label: str
    status: str = "queued"  # queued | running | done | failed | cancelled | interrupted
    progress: float = 0.0
    stage: str = ""
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    result: Any = None
    error: str | None = None

    def view(self) -> dict:
        d = asdict(self)
        d["progress_pct"] = round(self.progress * 100, 1)
        if self.status == "running" and self.started_at and self.progress > 0.02:
            elapsed = time.time() - self.started_at
            d["eta_s"] = round(elapsed / self.progress - elapsed)
        return d


class Cancelled(Exception):
    pass


class Ctx:
    """Handed to a job body: report progress, register child processes, check for cancel."""

    def __init__(self, mgr: "JobManager", job: Job) -> None:
        self._mgr, self.job = mgr, job
        self.proc: subprocess.Popen | None = None
        self.cancel = threading.Event()

    def progress(self, frac: float, stage: str | None = None) -> None:
        self.job.progress = max(self.job.progress, min(1.0, frac))
        if stage:
            self.job.stage = stage
        self._mgr.save(self.job, throttle=True)

    def stage(self, name: str, frac: float | None = None) -> None:
        self.job.stage = name
        if frac is not None:
            self.job.progress = max(self.job.progress, frac)
        self._mgr.save(self.job)
        self.check()

    def attach(self, proc: subprocess.Popen) -> None:
        self.proc = proc
        if self.cancel.is_set():
            proc.kill()

    def check(self) -> None:
        if self.cancel.is_set():
            raise Cancelled()


class JobManager:
    def __init__(self, s: Settings) -> None:
        self.s = s
        self.dir = s.state_dir / "jobs"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.jobs: dict[str, Job] = {}
        self.ctx: dict[str, Ctx] = {}
        self.lock = threading.Lock()
        self.slots = threading.Semaphore(s.max_jobs)
        self._last_save: dict[str, float] = {}
        self._load()

    def _load(self) -> None:
        for f in sorted(self.dir.glob("*.json"))[-200:]:
            try:
                job = Job(**json.loads(f.read_text("utf-8")))
            except Exception:
                continue
            if job.status in ("queued", "running"):
                job.status, job.error = "interrupted", "the media-forge server restarted while this job ran"
                self.save(job)
            self.jobs[job.id] = job

    def save(self, job: Job, throttle: bool = False) -> None:
        now = time.time()
        if throttle and now - self._last_save.get(job.id, 0) < 1.0:
            return
        self._last_save[job.id] = now
        tmp = self.dir / f"{job.id}.{os.getpid()}.tmp"
        tmp.write_text(json.dumps(asdict(job), default=str), "utf-8")
        os.replace(tmp, self.dir / f"{job.id}.json")

    def start(self, kind: str, label: str, body: Callable[[Ctx], Any]) -> Job:
        job = Job(id=f"{kind}-{int(time.time())}-{secrets.token_hex(3)}", kind=kind, label=label[:160])
        ctx = Ctx(self, job)
        with self.lock:
            self.jobs[job.id], self.ctx[job.id] = job, ctx
        self.save(job)

        def runner() -> None:
            with self.slots:  # MEDIA_MAX_JOBS heavy jobs at a time; the rest queue FIFO
                if ctx.cancel.is_set():
                    job.status, job.finished_at = "cancelled", time.time()
                    self.save(job)
                    return
                job.status, job.started_at = "running", time.time()
                self.save(job)
                try:
                    job.result = body(ctx)
                    job.status, job.progress = "done", 1.0
                except Cancelled:
                    job.status = "cancelled"
                except PolicyError as e:
                    job.status, job.error = "failed", str(e)
                except Exception as e:  # report, never crash the server
                    job.status = "failed"
                    job.error = f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=3)[-800:]}"
                finally:
                    job.finished_at = time.time()
                    self.save(job)

        threading.Thread(target=runner, name=job.id, daemon=True).start()
        return job

    def get(self, job_id: str) -> Job:
        job = self.jobs.get(job_id)
        if not job:
            raise PolicyError(f"no such job: {job_id}")
        return job

    def cancel(self, job_id: str) -> Job:
        job = self.get(job_id)
        ctx = self.ctx.get(job_id)
        if ctx and job.status in ("queued", "running"):
            ctx.cancel.set()
            if ctx.proc and ctx.proc.poll() is None:
                ctx.proc.kill()
        return job

    def recent(self, limit: int = 20) -> list[dict]:
        jobs = sorted(self.jobs.values(), key=lambda j: j.created_at, reverse=True)[:limit]
        return [j.view() for j in jobs]


def cleanup_partial(path: Path) -> None:
    """Remove a half-written output this server created (never anything else)."""
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass
