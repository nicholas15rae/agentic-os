"""Model manager for the built-in engine (Section 26 step 3).

  list_models()   every chat GGUF in the model library roots (os_api.scan_models: the D: model
                  folders, both LM Studio libraries, the Hugging Face caches); projector (mmproj) and
                  embedding files are listed apart
  vram()          the card's total / used / free MiB and its compute processes (nvidia-smi)
  estimate()      what a model needs on the GPU at the engine's settings: weights + KV cache +
                  recurrent state + compute buffers
  fit()           estimate vs what is free now (crediting back what our own engine holds, since a
                  load replaces it), less a safety margin
  load() / unload()  one model at a time: a load stops the engine's current model first. A load
                  that would not fit is REFUSED, so it can never push Bionic (Tony's live model) or
                  speech-to-text off the card.

COMPUTE_MIB is calibrated from step 5's real load (11-27); the estimate stays above the measurement.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Callable, Iterable, Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine import gguf_meta  # noqa: E402
from engine.llama_engine import Engine, EngineRefused, EngineSettings, TONY_ALIAS, TONY_GGUF  # noqa: E402

MIB = 1 << 20
# CUDA compute buffers + context. Calibrated 11-27 (step 5): Tony's Qwen3.5 9B Q4_K_M at 32k x 2, f16
# KV, flash attention measured 6176 MiB on the card (llama.cpp keeps token embeddings in RAM), vs
# 7295 estimated with 800 here. 500 keeps the estimate on the safe side (~6995).
COMPUTE_MIB = 500
MARGIN_MIB = 400        # always left free on the card
SKIP_DIRS = {".git", "node_modules", "__pycache__", "blobs"}  # HF `blobs` are the same files as `snapshots`


def _is_projector(name: str) -> bool:
    n = name.lower()
    return n.startswith("mmproj") or "-mmproj" in n or "projector" in n


def _is_embedder(name: str) -> bool:
    n = name.lower()
    return any(x in n for x in ("embed", "bge-", "e5-", "gte-", "minilm"))


def library_roots() -> list[str]:
    """The roots the app's model library already knows (Settings → model library), existing ones."""
    try:
        import os_api
        return [r["path"] for r in os_api.scan_models().get("roots", []) if r.get("exists")]
    except Exception:
        return [str(Path.home() / ".lmstudio" / "models")]


def list_models(roots: Optional[Iterable[str]] = None, max_depth: int = 6) -> dict:
    """{"chat": [...], "projectors": [...], "embedders": [...]}; each row: path, name, sizeMiB, root."""
    out = {"chat": [], "projectors": [], "embedders": []}
    seen: set[str] = set()
    for root in (library_roots() if roots is None else roots):
        base = Path(root)
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            depth = len(Path(dirpath).relative_to(base).parts)
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and depth < max_depth]
            for fn in filenames:
                if not fn.lower().endswith(".gguf"):
                    continue
                p = Path(dirpath) / fn
                try:
                    real = os.path.normcase(os.path.realpath(p))
                    size = p.stat().st_size
                except OSError:
                    continue
                if real in seen:
                    continue
                seen.add(real)
                row = {"path": str(p), "name": fn, "sizeMiB": round(size / MIB), "root": root}
                kind = "projectors" if _is_projector(fn) else "embedders" if _is_embedder(fn) else "chat"
                out[kind].append(row)
    for rows in out.values():
        rows.sort(key=lambda r: r["name"].lower())
    return out


def _nvsmi(args: list[str], run: Callable = subprocess.run) -> list[list[str]]:
    r = run(["nvidia-smi", *args, "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10)
    if r.returncode != 0:
        raise RuntimeError(f"nvidia-smi failed: {r.stderr.strip()[:200]}")
    return [[c.strip() for c in line.split(",")] for line in r.stdout.strip().splitlines() if line.strip()]


def vram(run: Callable = subprocess.run) -> dict:
    """Total / used / free MiB of GPU 0 and its compute processes (used MiB is None where Windows
    WDDM doesn't report it)."""
    name, total, used, free = _nvsmi(["--query-gpu=name,memory.total,memory.used,memory.free"], run)[0][:4]
    procs = []
    try:
        for row in _nvsmi(["--query-compute-apps=pid,process_name,used_memory"], run):
            if len(row) >= 3:
                mem = row[2]
                procs.append({"pid": int(row[0]) if row[0].isdigit() else row[0], "name": Path(row[1]).name,
                              "usedMiB": int(mem) if mem.isdigit() else None})
    except RuntimeError:
        pass
    return {"gpu": name, "totalMiB": int(total), "usedMiB": int(used), "freeMiB": int(free), "processes": procs}


def _recurrent_bytes(meta: dict, parallel: int) -> int:
    """Hybrid models' per-sequence recurrent state (f32): small next to the KV cache, but counted."""
    arch = meta.get("general.architecture", "")
    inner = meta.get(f"{arch}.ssm.inner_size")
    state = meta.get(f"{arch}.ssm.state_size")
    conv = meta.get(f"{arch}.ssm.conv_kernel") or 0
    if not (isinstance(inner, int) and isinstance(state, int)):
        return 0
    rec_layers = max(0, int(meta.get(f"{arch}.block_count", 0) or 0) - gguf_meta.attention_layers(meta))
    return rec_layers * (inner * state + inner * 3 * conv) * 4 * max(1, parallel)


def estimate(model_path: str, s: EngineSettings, mmproj: str = "", meta: Optional[dict] = None) -> dict:
    """MiB a model needs on the GPU at these settings (all layers offloaded)."""
    meta = meta if meta is not None else gguf_meta.read_meta(model_path)
    weights = Path(model_path).stat().st_size
    kv = gguf_meta.kv_cache_bytes(meta, s.ctx, s.kv_type_k, s.kv_type_v)
    rec = _recurrent_bytes(meta, s.parallel)
    proj = Path(mmproj).stat().st_size if mmproj else 0
    parts = {"weightsMiB": round(weights / MIB), "kvCacheMiB": round(kv / MIB), "recurrentMiB": round(rec / MIB),
             "projectorMiB": round(proj / MIB), "computeMiB": COMPUTE_MIB}
    return {**parts, "totalMiB": sum(parts.values()), "model": gguf_meta.summary(meta), "ctx": s.ctx,
            "kv": f"{s.kv_type_k}/{s.kv_type_v}"}


def _engine_mib(v: dict, engine_pid: Optional[int]) -> int:
    for p in v.get("processes", []):
        if engine_pid and p.get("pid") == engine_pid and isinstance(p.get("usedMiB"), int):
            return p["usedMiB"]
    return 0


def fit(model_path: str, s: EngineSettings, v: dict, engine_pid: Optional[int] = None,
        engine_running_mib: Optional[int] = None, mmproj: str = "", meta: Optional[dict] = None) -> dict:
    """Does it fit now? Free VRAM + what our own engine holds (a load replaces it) - margin."""
    need = estimate(model_path, s, mmproj, meta)
    ours = engine_running_mib if engine_running_mib is not None else _engine_mib(v, engine_pid)
    avail = v["freeMiB"] + ours - MARGIN_MIB
    return {**need, "freeMiB": v["freeMiB"], "reclaimMiB": ours, "availableMiB": avail,
            "fits": need["totalMiB"] <= avail, "fitsEmptyCard": need["totalMiB"] <= v["totalMiB"] - MARGIN_MIB,
            "shortMiB": max(0, need["totalMiB"] - avail)}


def _alias_for(model_path: str) -> str:
    p = Path(model_path)
    try:
        if os.path.samefile(p, TONY_GGUF):
            return TONY_ALIAS
    except OSError:
        pass
    return p.stem.lower()


class ModelManager:
    def __init__(self, engine: Optional[Engine] = None, vram_fn: Callable[[], dict] = vram):
        self.engine = engine or Engine()
        self._vram = vram_fn

    def status(self) -> dict:
        st = self.engine.status()
        try:
            v = self._vram()
        except Exception as e:
            v = {"error": str(e)}
        return {"engine": st, "vram": v}

    def check(self, model_path: str) -> dict:
        info = self.engine._pid_info() or {}
        return fit(model_path, self.engine.s, self._vram(), engine_pid=info.get("pid"), mmproj=self.engine.s.mmproj)

    def load(self, model_path: str, *, force: bool = False, alias: str = "") -> dict:
        """Swap the engine to `model_path`. Refused when the engine is off (unless `force`, approved
        tests only) or when the model would not fit next to what else is on the card."""
        if not (self.engine.s.enabled or force):
            raise EngineRefused("the built-in engine is off (engine.json enabled=false)")
        if not Path(model_path).is_file():
            raise EngineRefused(f"model not found: {model_path}")
        f = self.check(model_path)
        if not f["fits"]:
            raise EngineRefused(f"won't fit: needs {f['totalMiB']} MiB, {f['availableMiB']} MiB available "
                                f"({f['freeMiB']} free + {f['reclaimMiB']} ours - {MARGIN_MIB} margin)")
        self.engine.stop()
        st = self.engine.start(model_path, alias=alias or _alias_for(model_path), force=force)
        return {"engine": st, "fit": f}

    def unload(self) -> bool:
        return self.engine.stop()


def main(argv=None) -> int:
    import argparse
    import json
    ap = argparse.ArgumentParser(description="built-in engine model manager")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    sub.add_parser("vram")
    c = sub.add_parser("fit")
    c.add_argument("model", nargs="?", default=str(TONY_GGUF))
    ld = sub.add_parser("load")
    ld.add_argument("model")
    ld.add_argument("--force", action="store_true", help="although engine.json enabled=false (approved tests only)")
    sub.add_parser("unload")
    a = ap.parse_args(argv)
    mm = ModelManager()
    if a.cmd == "list":
        r = list_models()
        for kind, rows in r.items():
            print(f"== {kind} ({len(rows)})")
            for row in rows:
                print(f"  {row['sizeMiB']:>7} MiB  {row['path']}")
    elif a.cmd == "vram":
        print(json.dumps(vram(), indent=2))
    elif a.cmd == "fit":
        print(json.dumps(mm.check(a.model), indent=2))
    elif a.cmd == "load":
        print(json.dumps(mm.load(a.model, force=a.force), indent=2))
    elif a.cmd == "unload":
        print("unloaded" if mm.unload() else "nothing loaded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
