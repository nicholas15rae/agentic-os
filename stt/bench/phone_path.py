"""Phone STT path before/after, on the same clips: language_hub_api._transcribe(audio, "en") called
in-process (the gateway's own code, without the HTTP hop from the phone).

  before  : the baseline module (git 8b1bac6): verbose_json, no prompt, whisper.cpp :8178
  after/8178 : this module with policy.stt = whisper: json + vocabulary prompt + echo guard, :8178
  after/8177 : this module with policy.stt = faster-whisper: :8177 first (whisper.cpp behind it)

  python -I "G:\\agentic os\\stt\\bench\\phone_path.py" --old <path to the 8b1bac6 language_hub_api.py>
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLIPS = ROOT / "data" / "stt-bench" / "clips"
sys.path.insert(0, str(ROOT))


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def providers(policy: str, model: str) -> dict:
    return {"policy": {"stt": policy}, "providers": [
        {"id": "whisper", "label": "Whisper STT", "kind": "stt", "baseUrl": "http://127.0.0.1:8178/v1", "model": "base.en", "needsKey": False,
         "engine": "whispercpp", "language": "en", "modelsDir": "G:\\whisper\\models"},
        {"id": "faster-whisper", "label": "faster-whisper (GPU)", "kind": "stt", "baseUrl": "http://127.0.0.1:8177/v1", "model": model,
         "needsKey": False, "engine": "fasterwhisper", "language": "en"},
    ]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", required=True)
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--clips", default="s05_bm_george,s13_af_heart,l00_am_michael")
    a = ap.parse_args()
    old = load("lh_old", Path(a.old))
    new = load("lh_new", ROOT / "language_hub_api.py")
    manifest = {c["id"]: c for c in json.loads((CLIPS / "manifest.json").read_text(encoding="utf-8"))}
    arms = [
        ("before (8b1bac6): verbose_json, no prompt, :8178", old, providers("whisper", a.model)),
        ("after: json + prompt, policy whisper -> :8178", new, providers("whisper", a.model)),
        ("after: json + prompt, policy faster-whisper -> :8177", new, providers("faster-whisper", a.model)),
    ]
    out = []
    for cid in [c.strip() for c in a.clips.split(",") if c.strip()]:
        wav = (CLIPS / f"{cid}.wav").read_bytes()
        for name, mod, cfg in arms:
            mod._providers = (lambda c: (lambda: copy.deepcopy(c)))(cfg)
            mod._transcribe(wav, "en")  # warm-up
            ts, text = [], ""
            for _ in range(a.runs):
                t0 = time.perf_counter()
                r = mod._transcribe(wav, "en")
                ts.append(time.perf_counter() - t0)
                text = r["text"]
            row = {"clip": cid, "seconds": manifest[cid]["seconds"], "arm": name, "median_s": round(statistics.median(ts), 3),
                   "min_s": round(min(ts), 3), "max_s": round(max(ts), 3), "backend": r.get("backend", "whispercpp"),
                   "ref": manifest[cid]["text"], "text": text}
            out.append(row)
            print(f"{cid:16} {row['seconds']:5.2f}s  {name:52} median {row['median_s']:.3f}s  [{row['min_s']:.3f}-{row['max_s']:.3f}]  {text!r}", flush=True)
    dest = ROOT / "data" / "stt-bench" / f"phone-path-{time.strftime('%Y%m%d-%H%M%S')}.json"
    dest.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"-> {dest}", file=sys.stderr)


if __name__ == "__main__":
    main()
