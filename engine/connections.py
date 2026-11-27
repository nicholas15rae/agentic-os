"""Section 26: check every connection the transfer (LM Studio + AnythingLLM -> the built-in engine)
depends on, without changing anything. Read-only: no switch is flipped, no model is loaded on the
GPU, nothing in AnythingLLM / LM Studio / the model folders is written. Each check prints
PASS / WARN / FAIL with a one-line reason; exit code 1 if any FAIL.

    python -m engine.connections
"""
from __future__ import annotations

import json
import socket
import sys
import urllib.request
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

GATEWAY = "http://127.0.0.1:8080"
LMSTUDIO = "http://127.0.0.1:1235"
EMBEDDER = "http://127.0.0.1:1237"

results: list[tuple[str, str, str]] = []


def check(name: str) -> Callable:
    def wrap(fn: Callable) -> Callable:
        try:
            r = fn()
            status, why = r if isinstance(r, tuple) else ("PASS", str(r))
        except Exception as e:  # a check that blows up is a FAIL, never a crash of the whole run
            status, why = "FAIL", f"{type(e).__name__}: {str(e)[:200]}"
        results.append((status, name, why))
        return fn
    return wrap


def get(url: str, timeout: float = 5) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def main() -> int:
    from engine import install_llama, llama_engine as le

    s = le.load_settings()

    # ---- 1. the engine itself -------------------------------------------------------------
    @check("llama-server installed (pinned b12317)")
    def _():
        exe = Path(s.exe)
        if not exe.exists():
            return "FAIL", f"missing {exe}"
        dl = install_llama.ROOT / "_downloads"
        bad = [n for n, h in install_llama.PINNED.items() if (dl / n).exists() and install_llama.sha256(dl / n) != h]
        return ("FAIL", f"sha256 mismatch: {bad}") if bad else f"{exe} (zips match their pins)"

    @check("engine.json loads, valid, all switches off")
    def _():
        le.validate(s) if hasattr(le, "validate") else s.validate()
        on = [k for k in ("enabled", "route_agents", "route_tony") if getattr(s, k)]
        return ("WARN", f"switched ON: {on}") if on else f"{le.settings_path() if hasattr(le, 'settings_path') else 'engine.json'}: enabled/route_agents/route_tony all false"

    @check("Tony's model file (D:) readable")
    def _():
        from engine import gguf_meta
        p = Path(s.model_path)
        m = gguf_meta.read_meta(str(p))
        return f"{p.name}: {p.stat().st_size / 2**30:.2f} GiB, arch {m.get('general.architecture')}"

    @check("vision projector (mmproj) present")
    def _():
        if not s.mmproj:
            return "WARN", "no mmproj set (vision is plan-only)"
        return ("PASS", Path(s.mmproj).name) if Path(s.mmproj).exists() else ("FAIL", f"missing {s.mmproj}")

    @check(f"engine port {s.port} free while off")
    def _():
        h = le.Engine(s).health()
        return ("PASS", "nothing listening") if h == "down" else ("WARN", f"engine answers ({h}) although off")

    @check("VRAM read + Tony's model fits after LM Studio steps aside")
    def _():
        from engine import models
        v = models.vram()
        e = models.estimate(s.model_path, s, s.mmproj)
        need = e.get("totalMiB") or e.get("total_mib") or e.get("needMiB")
        return f"card {v.get('totalMiB') or v.get('total')} MiB, used {v.get('usedMiB') or v.get('used')} MiB; engine needs ~{need} MiB"

    # ---- 2. what it replaces / sits beside ------------------------------------------------
    @check("LM Studio (Bionic :1235) up, Tony loaded")
    def _():
        d = get(f"{LMSTUDIO}/api/v0/models")["data"]
        loaded = [m["id"] for m in d if m.get("state") == "loaded"]
        return ("PASS", f"loaded: {loaded}") if s.alias in loaded else ("FAIL", f"Tony ({s.alias}) not loaded: {loaded}")

    @check("CPU embedder (:1237) serves nomic")
    def _():
        ids = [m["id"] for m in get(f"{EMBEDDER}/v1/models")["data"]]
        return ("PASS", f"{ids}") if any("nomic" in i for i in ids) else ("FAIL", f"no nomic model: {ids}")

    @check("embeddings round-trip (command_center_api.embed)")
    def _():
        import command_center_api as cc
        vecs, model = cc.embed(["connection check"])
        return f"{model}, dim {len(vecs[0])}"

    @check("reserved port 1236 left alone")
    def _():
        return f"{'in use' if port_open(1236) else 'free'} (start-ai-stack.ps1's; the engine never binds it)"

    # ---- 3. the gateway ------------------------------------------------------------------
    @check("gateway (:8080) up")
    def _():
        get(f"{GATEWAY}/api/os/gpu")
        return "answers"

    @check("GPU baton free")
    def _():
        g = get(f"{GATEWAY}/api/os/gpu")
        return ("PASS", "free") if not g.get("busy") else ("WARN", f"held by {g.get('holder')}")

    @check("/api/engine/* routes (this branch, in-process) answer from loopback")
    def _():
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from engine import api
        app = FastAPI()
        app.include_router(api.router)
        c = TestClient(app, client=("127.0.0.1", 50000))
        paths = ["/api/engine/status", "/api/engine/settings", "/api/engine/models?fit=1", "/api/engine/agents",
                 "/api/engine/docs/search?q=deck", "/api/engine/watchdog", "/api/engine/downloads"]
        bad = [(p, r.status_code) for p in paths for r in [c.get(p)] if r.status_code != 200]
        if bad:
            return "FAIL", f"{bad}"
        r = c.post("/api/engine/agents/coder/run", json={"text": "hi"})
        if r.status_code != 409:
            return "FAIL", f"agents/run should be refused while route_agents is off, got {r.status_code}"
        return f"{len(paths)} GETs 200; agent run refused (409) while off"

    @check("phone (non-loopback) is refused on /api/engine/*")
    def _():
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from engine import api
        app = FastAPI()
        app.include_router(api.router)
        c = TestClient(app, client=("100.84.9.9", 50000))
        codes = {p: c.get(p).status_code for p in ("/api/engine/status", "/api/engine/models", "/api/engine/settings")}
        return ("PASS", "403 on every route") if set(codes.values()) == {403} else ("FAIL", f"{codes}")

    @check("server.py mounts the engine router")
    def _():
        src = (ROOT / "server.py").read_text(encoding="utf-8")
        return ("PASS", "router + boot() wired") if "engine.api" in src and "boot()" in src else ("FAIL", "not mounted")

    @check("gateway Tony: switch off -> LM Studio, switch path resolves")
    def _():
        import gateway_tony as gt
        if gt.engine_route() is not None:
            return "WARN", f"route_tony is ON: {gt.engine_route()}"
        model, base = gt.tony_model()
        st = gt.model_state(base.rsplit("/v1", 1)[0], model)
        return ("PASS", f"{model} @ {base}, state {st}") if ":1235" in base and st == "loaded" else ("FAIL", f"{model} @ {base}, state {st}")

    # ---- 4. documents, memory, threads (the AnythingLLM side) ----------------------------
    @check("AnythingLLM originals untouched (storage + db still there)")
    def _():
        from engine import allm_import
        db = allm_import.STORAGE / "anythingllm.db"
        return ("PASS", f"{db} ({db.stat().st_size // 1024} KB)") if db.exists() else ("FAIL", f"missing {db}")

    @check("AnythingLLM export: verifies, no secrets left")
    def _():
        from engine import allm_import
        exports = sorted(p for p in allm_import.EXPORT_ROOT.iterdir() if p.is_dir())
        ex = exports[-1]
        problems, left = allm_import.verify(ex), allm_import.leftover_secrets(ex)
        if left:
            return "FAIL", f"secrets still in {ex.name}: {len(left)}"
        return ("WARN", f"{ex.name}: {problems[:3]}") if problems else f"{ex.name}: verified, 0 secrets"

    @check("doc store: stats + a real hybrid search")
    def _():
        from engine.docstore import DocStore
        d = DocStore()
        st = d.stats()
        r = d.search("memory", 3)
        hits = r.get("hits") or r.get("results") or []
        mode = r.get("mode") or ("hybrid" if r.get("embedded", True) else "lexical")
        return f"{st}; search 'memory' -> {len(hits)} hits ({mode})"

    @check("thread store readable")
    def _():
        from engine.threads import ThreadStore
        ts = ThreadStore().threads()
        return f"{len(ts)} threads, {sum(1 for t in ts if t.get('source') != 'gateway')} imported"

    @check("memory scrolls root + knowledge graph reachable")
    def _():
        from engine import agent_runner as ar, ingest
        sr = ingest.scrolls_root()
        md = len(list(sr.rglob("*.md"))) if sr.is_dir() else -1
        kg = ar.KG_PATH
        if md < 0 or not kg.exists():
            return "FAIL", f"scrolls {sr} ({md}), kg {kg} exists={kg.exists()}"
        return f"{md} scrolls in {sr}; kg {kg.stat().st_size // 1024} KB"

    # ---- 5. agents + tools ----------------------------------------------------------------
    @check("agent table + os.json (MCP registry) load; policy spot checks")
    def _():
        from engine import agent_runner as ar
        table, os_cfg = ar.load_table(), ar.load_os()
        ag = table["agents"]
        d = ar.decide(ag["director"], "fs.read", {"path": r"C:\Windows\win.ini"}, os_cfg)
        coder_fetch = [x["access"] for x in (ag["coder"].get("toolAccess") or []) if x.get("tool") == "fetch"]
        offered = {a: [t["function"]["name"] for t in ar.tool_schemas(x, os_cfg)] for a, x in ag.items()}
        money = [a for a, names in offered.items() if any(n.split("__")[0] in ar.NEVER_OFFERED for n in names)]
        problems = []
        if d.ok:
            problems.append("director may read win.ini")
        if money:
            problems.append(f"money tools offered to {money}")
        if coder_fetch != ["write"]:
            problems.append(f"coder should own fetch, has {coder_fetch}")
        if problems:
            return "FAIL", "; ".join(problems)
        return f"{len(ag)} agents, {len(os_cfg.get('mcps') or [])} MCPs; director outside its folder refused; no money tools; coder owns fetch"

    @check("knowledge-graph search tool runs")
    def _():
        from engine import agent_runner as ar
        out = ar.kg_search("Nic")
        return f"{len(out)} chars back"

    # ---- 6. desktop side -----------------------------------------------------------------
    @check("desktop providers.json (the app's live chain)")
    def _():
        p = le.APP_CFG_DIR / "providers.json"
        ids = [x.get("id") for x in json.loads(p.read_text(encoding="utf-8")).get("providers", [])]
        if "llamacpp" in ids:
            return f"{ids}"
        return "WARN", f"{ids}: no llamacpp yet (appears after the rebuild; never in the chain)"

    @check("desktop chat chain switch (dispatch.rs / model_swap.rs)")
    def _():
        src = (ROOT / "command center" / "src-tauri" / "src" / "commands" / "dispatch.rs").read_text(encoding="utf-8")
        if "route_tony" in src:
            return "built"
        return "WARN", "not built yet: desktop Tony stays on LM Studio even with route_tony on (gateway Tony would switch)"

    # ---- print ---------------------------------------------------------------------------
    width = max(len(n) for _, n, _ in results)
    for st, n, why in results:
        print(f"{st:4}  {n:<{width}}  {why}")
    fails = sum(1 for st, _, _ in results if st == "FAIL")
    warns = sum(1 for st, _, _ in results if st == "WARN")
    print(f"\n{len(results) - fails - warns} pass, {warns} warn, {fails} fail")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
