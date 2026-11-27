"""Stdio MCP smoke test: initialize → tools/list → optional tools/call, like the gateway does.

Usage:
  python mcp_smoke.py [--env K=V ...] [--call TOOL JSON_ARGS ...] -- <command> [args...]

Exits non-zero if the handshake, the listing or any call fails. Speaks the same
newline-delimited JSON-RPC as src-tauri/src/commands/mcp_session.rs (protocol 2025-06-18).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", action="append", default=[], help="K=V passed to the server")
    ap.add_argument("--call", nargs=2, action="append", default=[], metavar=("TOOL", "JSON"))
    ap.add_argument("--timeout", type=float, default=120)
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles default to cp1252
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
    if not cmd:
        ap.error("missing server command after --")
    env = dict(os.environ)
    for kv in a.env:
        k, _, v = kv.partition("=")
        env[k] = v
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         env=env, text=True, encoding="utf-8", creationflags=flags)
    err: list[str] = []
    threading.Thread(target=lambda: err.extend(p.stderr), daemon=True).start()  # type: ignore[arg-type]
    nid = 0

    def rpc(method: str, params: dict | None = None, notify: bool = False) -> dict | None:
        nonlocal nid
        msg: dict = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if not notify:
            nid += 1
            msg["id"] = nid
        assert p.stdin and p.stdout
        p.stdin.write(json.dumps(msg) + "\n")
        p.stdin.flush()
        if notify:
            return None
        deadline = time.time() + a.timeout
        while time.time() < deadline:
            line = p.stdout.readline()
            if not line:
                raise RuntimeError("server closed stdout. stderr:\n" + "".join(err[-20:]))
            try:
                resp = json.loads(line)
            except json.JSONDecodeError:
                continue  # stray log line on stdout
            if resp.get("id") == nid:
                if "error" in resp:
                    raise RuntimeError(f"{method}: {resp['error']}")
                return resp["result"]
        raise TimeoutError(f"{method} timed out after {a.timeout}s")

    ok = True
    try:
        t0 = time.time()
        init = rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                  "clientInfo": {"name": "mcp-smoke", "version": "1"}})
        rpc("notifications/initialized", notify=True)
        info = (init or {}).get("serverInfo", {})
        print(f"initialize ok ({time.time() - t0:.1f}s): {info.get('name')} {info.get('version')} "
              f"protocol={(init or {}).get('protocolVersion')}")
        tools = (rpc("tools/list", {}) or {}).get("tools", [])
        print(f"tools/list ok: {len(tools)} tools")
        for t in tools:
            print(f"  - {t['name']}")
        for name, args in a.call:
            t0 = time.time()
            res = rpc("tools/call", {"name": name, "arguments": json.loads(args)}) or {}
            text = "".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
            flag = "ERROR" if res.get("isError") else "ok"
            ok &= not res.get("isError")
            print(f"call {name} {flag} ({time.time() - t0:.1f}s):\n{text[:3000]}")
    except Exception as e:  # report and fail
        print(f"FAILED: {e}")
        ok = False
    finally:
        p.kill()
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
