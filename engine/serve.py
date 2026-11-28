"""The built-in engine's control routes on their own, as a loopback sidecar (Section 26).

    python -m engine.serve [--port 8081]

Serves only `/api/engine/*` (engine/api.py: status, settings, models + fit, load / unload,
download, delete, yield / reclaim, docs, watchdog, agents, bench/last, test), bound to 127.0.0.1
and loopback-only per route, from THIS checkout's code. It exists so the engine screen works while
the real gateway (:8080, serving the phone, the inbox, the vault...) still runs code without these
routes; it never replaces that gateway and touches none of its data. The desktop's `engine_call`
command asks the gateway first and falls back here on a 404. After a merge the gateway answers and
this sidecar is no longer needed.

boot() runs as in the gateway: the watchdog (idle while engine.json enabled=false), and the
engine's model only when enabled=true.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

PORT = 8081


def app():
    from fastapi import FastAPI
    from engine import api
    a = FastAPI(title="engine sidecar", docs_url=None, redoc_url=None, openapi_url=None)
    a.include_router(api.router)

    @a.get("/api/engine/sidecar")
    def sidecar():
        return {"sidecar": True, "root": str(ROOT)}
    return a


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="engine control sidecar (loopback only)")
    ap.add_argument("--port", type=int, default=PORT)
    a = ap.parse_args(argv)
    if a.port in (1235, 1236, 1237, 1238, 8080, 8443):
        print(f"REFUSED: port {a.port} is reserved")
        return 2
    import uvicorn
    from engine import api
    application = app()
    print(api.boot())
    uvicorn.run(application, host="127.0.0.1", port=a.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
