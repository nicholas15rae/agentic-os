"""Step 5: benchmark the built-in engine on the GPU against Tony's model, then put Tony back exactly.

Nic's rule (11-27): only when nothing else uses the GPU. Sequence:
  1. preflight: GPU baton free; Tony's model loaded in Bionic; snapshot its load config and VRAM
  2. take the gateway's GPU baton as a MAINTENANCE lease (gateway Tony then answers the maintenance
     line instead of calling Bionic, so nothing JIT-loads Tony at Bionic's bad defaults); re-asserted
     every 5 s because the desktop's slot mirror may overwrite it
  3. unload Tony's model in Bionic (model_swap.rs's call), wait for the VRAM to come back
  4. load the engine on the GPU with Tony's GGUF (fit-checked), measure its VRAM, run the live
     template / tool-call checks and the same latency benchmark as the baseline
     (a guard thread stops the engine at once if Bionic loads anything meanwhile)
  5. ALWAYS (finally): stop the engine, reload Tony in Bionic with the app's own load body
     (gateway_tony.load_body = services.rs / model_swap.rs production settings), warm up, compare the
     config with the snapshot, release the lease, and check Tony answers a real turn
Results: data/engine/bench/<stamp>-swap.json + stdout.
"""
from __future__ import annotations

import json
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import command_center_api as cc  # noqa: E402
import gateway_tony as gt  # noqa: E402
from engine import bench_tony, models  # noqa: E402
from engine.llama_engine import Engine, load_settings  # noqa: E402
from engine.template_check import live_checks  # noqa: E402

GATEWAY = "http://127.0.0.1:8080"
HOLDER = "maintenance · section 26 engine benchmark"
COMPARE = ("context_length", "parallel", "flash_attention", "offload_kv_cache_to_gpu", "eval_batch_size", "physical_batch_size")


def _json(method: str, url: str, body=None, timeout: float = 30.0):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        txt = r.read().decode("utf-8", "replace")
        return json.loads(txt) if txt.strip() else {}


def bionic_instances(root: str) -> list[dict]:
    d = _json("GET", f"{root}/api/v1/models", timeout=10)
    out = []
    for m in d.get("models", d.get("data", [])):
        for inst in m.get("loaded_instances") or []:
            out.append({"key": m.get("key"), "id": inst.get("id"), "config": inst.get("config") or {}})
    return out


def set_lease(busy: bool) -> dict:
    until = int((time.time() + 14 * 60) * 1000) if busy else None
    return _json("PUT", f"{GATEWAY}/api/os/gpu", {"busy": busy, "holder": HOLDER if busy else "", "until": until})


def main() -> int:
    log: dict = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "steps": []}

    def step(name, **kw):
        log["steps"].append({"at": round(time.time(), 1), "step": name, **kw})
        print(f"[{time.strftime('%H:%M:%S')}] {name} {json.dumps(kw)[:300] if kw else ''}", flush=True)

    model, base = gt.tony_model()
    root = gt.bionic_root(base)
    gpu = _json("GET", f"{GATEWAY}/api/os/gpu")
    if gpu.get("active"):
        print(f"SKIPPED: GPU baton held by {gpu.get('holder')}")
        return 2
    if gt.model_state(root, model) != "loaded":
        print(f"SKIPPED: Tony's model {model} isn't loaded in Bionic")
        return 2
    snap = bionic_instances(root)
    tony = [i for i in snap if i["key"] == model]
    if len(tony) != 1 or len(snap) != 1:
        print(f"SKIPPED: expected exactly Tony's model loaded in Bionic, found {[i['id'] for i in snap]}")
        return 2
    before_cfg = {k: tony[0]["config"].get(k) for k in COMPARE}
    v0 = models.vram()
    step("preflight", model=model, config=before_cfg, vramUsedMiB=v0["usedMiB"])

    stop_hb = threading.Event()
    aborted: list[str] = []
    eng = Engine(load_settings())

    def heartbeat():
        while not stop_hb.wait(5):
            try:
                g = _json("GET", f"{GATEWAY}/api/os/gpu", timeout=5)
                if g.get("holder") != HOLDER:
                    set_lease(True)
            except Exception:
                pass
            try:  # guard: Bionic must stay empty while the engine holds the card
                if bionic_instances(root) and eng.health() != "down":
                    aborted.append("Bionic loaded a model during the engine window")
                    eng.stop()
            except Exception:
                pass

    try:
        set_lease(True)
        step("lease taken", holder=HOLDER)
        threading.Thread(target=heartbeat, daemon=True).start()
        r = _json("POST", f"{root}/api/v1/models/unload", {"instance_id": tony[0]["id"]}, timeout=60)
        step("bionic unloaded", response=r)
        for _ in range(40):
            time.sleep(0.5)
            if models.vram()["usedMiB"] < v0["usedMiB"] - 4000:
                break
        v1 = models.vram()
        step("vram after unload", usedMiB=v1["usedMiB"], freeMiB=v1["freeMiB"])
        mm = models.ModelManager(eng)
        fit = mm.check(eng.s.model_path)
        step("fit", needMiB=fit["totalMiB"], availableMiB=fit["availableMiB"], fits=fit["fits"])
        if not fit["fits"]:
            raise RuntimeError("engine model does not fit after unloading Bionic")
        t0 = time.monotonic()
        st = mm.load(eng.s.model_path, force=True)
        load_s = round(time.monotonic() - t0, 1)
        v2 = models.vram()
        step("engine loaded", loadSecs=load_s, health=st["engine"]["health"], vramUsedMiB=v2["usedMiB"],
             engineMiB=v2["usedMiB"] - v1["usedMiB"], estimateMiB=fit["totalMiB"])
        log["engineVram"] = {"measuredMiB": v2["usedMiB"] - v1["usedMiB"], "estimateMiB": fit["totalMiB"], "loadSecs": load_s}
        if aborted:
            raise RuntimeError(aborted[0])
        checks = live_checks(eng.s.base_url, eng.s.alias)
        log["templateChecks"] = checks
        step("template checks", ok=sum(c["ok"] for c in checks), total=len(checks))
        res = bench_tony.run("engine", 3, base=eng.s.base_url, model=eng.s.alias)
        log["bench"] = {"summary": res.summary(), "line": bench_tony.markdown_line(res)}
        step("benchmark", **res.summary())
        if aborted:
            raise RuntimeError(aborted[0])
    except Exception as e:
        log["error"] = f"{type(e).__name__}: {e}"[:400]
        step("ERROR", error=log["error"])
    finally:
        try:
            eng.stop()
            step("engine stopped")
        except Exception as e:
            step("engine stop failed", error=str(e)[:200])
        restored = False
        for attempt in range(2):
            try:
                if gt.model_state(root, model) != "loaded":
                    _json("POST", f"{root}/api/v1/models/load", gt.load_body(model), timeout=300)
                after = [i for i in bionic_instances(root) if i["key"] == model]
                after_cfg = {k: after[0]["config"].get(k) for k in COMPARE} if after else {}
                log["restore"] = {"config": after_cfg, "sameAsBefore": after_cfg == before_cfg,
                                  "diff": {k: (before_cfg.get(k), after_cfg.get(k)) for k in COMPARE if before_cfg.get(k) != after_cfg.get(k)}}
                restored = bool(after)
                step("bionic reloaded", **log["restore"])
                break
            except Exception as e:
                step("reload attempt failed", attempt=attempt, error=str(e)[:200])
                time.sleep(3)
        stop_hb.set()
        try:
            set_lease(False)
            step("lease released")
        except Exception as e:
            step("lease release failed", error=str(e)[:200])
        if restored:
            try:  # warm-up + "does Tony answer": one real turn through gateway Tony's own path
                msgs = gt.build_messages({"text": "quick check, are you there?"})
                t1 = time.monotonic()
                text = cc.llm_stream(msgs, model=model, base_url=base, max_tokens=60, first_token_s=60, total_s=120)
                log["tonyAnswers"] = {"ok": bool(text.strip()), "secs": round(time.monotonic() - t1, 2), "reply": text.strip()[:120]}
            except Exception as e:
                log["tonyAnswers"] = {"ok": False, "error": str(e)[:200]}
            step("tony answers", **log["tonyAnswers"])
        else:
            log["tonyAnswers"] = {"ok": False, "error": "Tony's model NOT reloaded in Bionic"}
            step("TONY NOT RESTORED", **log["tonyAnswers"])
        log["vramEnd"] = models.vram()["usedMiB"]
        out = ROOT / "data" / "engine" / "bench"
        out.mkdir(parents=True, exist_ok=True)
        f = out / f"{time.strftime('%Y%m%d-%H%M%S')}-swap.json"
        f.write_text(json.dumps(log, indent=2, default=str), encoding="utf-8")
        print(f"saved {f}")
    return 0 if ("error" not in log and log.get("tonyAnswers", {}).get("ok")) else 1


if __name__ == "__main__":
    sys.exit(main())
