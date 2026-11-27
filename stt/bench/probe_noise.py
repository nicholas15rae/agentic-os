"""Per-clip segment stats (no_speech_prob, avg_logprob, compression ratio) from the running :8177
server for the non-speech clips and a few short speech clips: the data behind the noise guard.

  python -I "G:\\agentic os\\stt\\bench\\probe_noise.py" [--hotwords] [--beam 5]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench import CLIPS, FW, PROMPT, post  # noqa: E402

import urllib.request  # noqa: E402
import uuid  # noqa: E402


def verbose(wav: bytes, fields: dict) -> dict:
    bnd = "----probe" + uuid.uuid4().hex
    body = bytearray()
    for k, v in fields.items():
        body += f'--{bnd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    body += f'--{bnd}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode()
    body += wav + f"\r\n--{bnd}--\r\n".encode()
    req = urllib.request.Request(f"{FW}/v1/audio/transcriptions", data=bytes(body), headers={"Content-Type": f"multipart/form-data; boundary={bnd}"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hotwords", action="store_true")
    ap.add_argument("--beam", default="5")
    ap.add_argument("--vad", default="")
    a = ap.parse_args()
    clips = json.loads((CLIPS / "manifest.json").read_text(encoding="utf-8"))
    pick = [c for c in clips if c["kind"] == "noise"] + [c for c in clips if c["kind"] == "speech" and c["seconds"] < 2.5][:10]
    fields = {"response_format": "verbose_json", "temperature": "0", "language": "en", "beam_size": a.beam, ("hotwords" if a.hotwords else "prompt"): PROMPT}
    if a.vad:
        fields["vad"] = a.vad
    for c in pick:
        out = verbose((CLIPS / f"{c['id']}.wav").read_bytes(), fields)
        segs = out.get("segments") or []
        stats = [(s.get("no_speech_prob"), s.get("avg_logprob"), s.get("compression_ratio"), s.get("temperature"), s.get("text")) for s in segs]
        print(f"{c['id']:20} {out.get('text')!r:40} {stats}")


if __name__ == "__main__":
    main()
