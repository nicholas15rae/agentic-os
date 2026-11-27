"""Gateway endpoints for the built-in engine: /api/engine/* (Section 26). Desktop only: every route
calls command_center_api.require_loopback, so the phone (over NetBird) can never load, download or
delete a model. The phone keeps talking to Tony through the gateway as before.

  GET  /api/engine/status            engine (enabled, health, model, pid) + VRAM
  GET  /api/engine/settings          engine.json (defaults filled in)
  PUT  /api/engine/settings          validated; this is Nic's on/off switch (the app's toggle)
  GET  /api/engine/models            library GGUFs (chat / projectors / embedders); ?fit=1 adds the
                                     VRAM fit of each chat model at the current settings
  GET  /api/engine/fit?path=         one model's fit
  POST /api/engine/load {path}       swap the engine to that model (refused while off / won't fit)
  POST /api/engine/unload
  POST /api/engine/download {repo, filename, destRoot, revision?}   background, resumable
  GET  /api/engine/downloads         progress of this process's downloads
  POST /api/engine/delete {path, confirm}   to the Recycle Bin; confirm = the file name
  POST /api/engine/yield {holder}    GPU baton: remember the model and step aside
  POST /api/engine/reclaim           GPU baton: bring the same model back, warm
  GET  /api/engine/docs/search?q=    the doc store (not the vault)
  GET  /api/engine/watchdog          the last watchdog events

boot() (called by server.py when it runs as the gateway): starts the watchdog thread, and, only
when engine.json has enabled=true, starts the engine with its configured model (Tony's). With the
default enabled=false it starts nothing but an idle watchdog.
"""
from __future__ import annotations

import dataclasses
import json
import threading
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from engine import download as dl
from engine import models as mdl
from engine.llama_engine import Engine, EngineRefused, EngineSettings, load_settings, save_settings

router = APIRouter(prefix="/api/engine", tags=["engine"])
_downloads: dict[str, dict] = {}
_lock = threading.Lock()


def _guard(request: Request) -> None:
    import command_center_api as cc
    cc.require_loopback(request)


def _manager() -> mdl.ModelManager:
    return mdl.ModelManager(Engine(load_settings()))


@router.get("/status")
def status(request: Request):
    _guard(request)
    return _manager().status()


@router.get("/settings")
def get_settings(request: Request):
    _guard(request)
    return dataclasses.asdict(load_settings())


@router.put("/settings")
def put_settings(request: Request, body: dict):
    _guard(request)
    cur = dataclasses.asdict(load_settings())
    known = {f.name for f in dataclasses.fields(EngineSettings)}
    unknown = set(body) - known
    if unknown:
        raise HTTPException(400, f"unknown settings: {sorted(unknown)}")
    try:
        s = EngineSettings(**{**cur, **body})
        save_settings(s)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, str(e))
    return dataclasses.asdict(s)


@router.get("/models")
def models(request: Request, fit: bool = False):
    _guard(request)
    out = mdl.list_models()
    if fit:
        mm = _manager()
        try:
            v = mm._vram()
        except Exception as e:
            v = None
            out["vramError"] = str(e)
        info = mm.engine._pid_info() or {}
        for row in out["chat"]:
            try:
                row["fit"] = mdl.fit(row["path"], mm.engine.s, v, engine_pid=info.get("pid")) if v else None
            except Exception as e:
                row["fit"] = {"error": str(e)[:200]}
            row["loaded"] = bool(info.get("model")) and row["path"] == info.get("model")
    return out


@router.get("/fit")
def fit(request: Request, path: str):
    _guard(request)
    try:
        return _manager().check(path)
    except (OSError, ValueError) as e:
        raise HTTPException(400, str(e))


@router.post("/load")
def load(request: Request, body: dict):
    _guard(request)
    try:
        return _manager().load(str(body.get("path") or ""))
    except EngineRefused as e:
        raise HTTPException(409, str(e))
    except (RuntimeError, TimeoutError) as e:
        raise HTTPException(502, str(e))


@router.post("/unload")
def unload(request: Request):
    _guard(request)
    return {"unloaded": _manager().unload()}


def _run_download(key: str, repo: str, filename: str, dest_root: str, revision: str) -> None:
    def progress(done: int, total: Optional[int]) -> None:
        with _lock:
            _downloads[key].update(done=done, total=total)
    try:
        res = dl.download(repo, filename, dest_root, mdl.library_roots(), revision, progress=progress)
        with _lock:
            _downloads[key].update(state=res["status"], result=res)
    except Exception as e:
        with _lock:
            _downloads[key].update(state="failed", error=str(e)[:300])


@router.post("/download")
def download(request: Request, body: dict):
    _guard(request)
    repo, fn = str(body.get("repo") or ""), str(body.get("filename") or "")
    dest, rev = str(body.get("destRoot") or ""), str(body.get("revision") or "main")
    try:
        dl.plan(repo, fn, dest, mdl.library_roots(), rev)
    except dl.DownloadRefused as e:
        raise HTTPException(400, str(e))
    key = f"{repo}/{fn}"
    with _lock:
        if _downloads.get(key, {}).get("state") == "running":
            return _downloads[key]
        _downloads[key] = {"key": key, "state": "running", "done": 0, "total": None, "startedAt": time.time()}
    threading.Thread(target=_run_download, args=(key, repo, fn, dest, rev), daemon=True, name=f"engine-dl {key}").start()
    return _downloads[key]


@router.get("/downloads")
def downloads(request: Request):
    _guard(request)
    with _lock:
        return list(_downloads.values())


@router.post("/delete")
def delete(request: Request, body: dict):
    _guard(request)
    eng = Engine(load_settings())
    loaded = [(eng._pid_info() or {}).get("model") or ""]
    try:
        return dl.trash(str(body.get("path") or ""), str(body.get("confirm") or ""), mdl.library_roots(), loaded)
    except dl.DownloadRefused as e:
        raise HTTPException(400, str(e))
    except OSError as e:
        raise HTTPException(500, str(e))


@router.post("/yield")
def yield_gpu(request: Request, body: dict):
    """A GPU borrower (ComfyUI, training) asks the engine to step aside; reclaim brings it back."""
    _guard(request)
    from engine import baton
    return baton.yield_gpu(str(body.get("holder") or "unknown"), Engine(load_settings()))


@router.post("/reclaim")
def reclaim_gpu(request: Request):
    _guard(request)
    from engine import baton
    try:
        return baton.reclaim_gpu(Engine(load_settings()))
    except (EngineRefused, RuntimeError, TimeoutError) as e:
        raise HTTPException(502, str(e))


@router.get("/docs/search")
def docs_search(request: Request, q: str, k: int = 8):
    _guard(request)
    from engine.docstore import DocStore
    return DocStore().search(q, max(1, min(k, 50)))


@router.get("/watchdog")
def watchdog_log(request: Request, n: int = 50):
    _guard(request)
    p = Engine(load_settings()).data / "logs" / "watchdog.jsonl"
    try:
        lines = p.read_text(encoding="utf-8").splitlines()[-max(1, min(n, 500)):]
    except OSError:
        return []
    out: list[Any] = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


@router.get("/agents")
def agents(request: Request):
    """The gateway agent table, without prompt text: source, tools + access, frozen, switch state."""
    _guard(request)
    from engine import agent_runner as ar
    try:
        table = ar.load_table()
    except (OSError, ValueError):
        return {"routeAgents": load_settings().route_agents, "agents": {}, "note": "no agent table yet (python -m engine.agents_migrate <export>)"}
    rows = {a: {"promptSource": x.get("promptSource"), "hasPrompt": bool(x.get("prompt")), "toolAccess": x.get("toolAccess"),
                "frozen": x.get("frozen"), "migrate": x.get("migrate"), "whenUnfrozen": x.get("whenUnfrozen")}
            for a, x in (table.get("agents") or {}).items()}
    return {"routeAgents": load_settings().route_agents, "agents": rows}


@router.post("/agents/{agent}/run")
def run_agent(request: Request, agent: str, body: dict):
    """One turn for a gateway agent on the built-in engine. Refused while route_agents is off."""
    _guard(request)
    from engine import agent_runner as ar
    s = load_settings()
    text = str(body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text is required")
    try:
        if not s.route_agents:
            raise ar.AgentRefused("gateway agents are off (engine.json route_agents=false)")
        if Engine(s).health() != "ok":
            raise ar.AgentRefused("the built-in engine isn't running")
        from engine.threads import ThreadStore
        store = ThreadStore()
        tid = str(body.get("threadId") or "")
        th = store.thread(tid) if tid else None
        if tid and (not th or th["agent"] != agent or th["source"] != "gateway"):
            raise ar.AgentRefused("that thread isn't a live gateway thread of this agent")
        tid = tid or store.new_thread(agent, text[:60])
        r = ar.run(agent, text[:8000], table=ar.load_table(), os_cfg=ar.load_os(), chat=ar.openai_chat(s.base_url, s.alias),
                   enabled=s.route_agents, history=store.history(tid))
        store.append(tid, "user", text[:8000])
        store.append(tid, "assistant", r.answer)
    except ar.AgentRefused as e:
        raise HTTPException(409, str(e))
    except (OSError, ValueError) as e:
        raise HTTPException(502, str(e)[:300])
    return {"agent": r.agent, "threadId": tid, "answer": r.answer, "calls": r.calls}


_booted = False


def boot() -> dict:
    """Gateway start-up. Idempotent. Off by default: only an idle watchdog."""
    global _booted
    if _booted:
        return {"booted": "already"}
    _booted = True
    from engine.watchdog import Watchdog
    s = load_settings()
    started = None
    if s.enabled:
        eng = Engine(s)
        if eng.health() == "down":
            try:
                started = eng.start()
            except Exception as e:
                started = {"error": str(e)[:300]}
    threading.Thread(target=Watchdog().run, daemon=True, name="engine-watchdog").start()
    return {"enabled": s.enabled, "started": started}
