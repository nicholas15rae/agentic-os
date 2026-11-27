"""The built-in chat engine: one supervised official llama-server (Section 26 step 2).

OpenAI-compatible on http://127.0.0.1:1238/v1 (/chat/completions with streaming, /models,
/health), so Tony, the gateway, Scene Reader, n8n and the phone could switch with a providers.json
base_url change. It is NOT in anyone's path yet: `enabled` is false by default and `start()` refuses
while it is (pass force=True only for a test Nic approved, e.g. the step-5 benchmark).

Speed settings (all in engine.json beside providers.json, all with safe defaults):
  * prompt cache: `--cache-reuse N` reuses the matching prefix of the last prompt in a slot (Tony's
    byte-stable system message), `cache_prompt` is on per request by default in llama-server;
  * `--slot-save-path` lets a slot's KV cache be saved / restored (warm restart after a reload);
  * keep warm: llama-server never unloads a model on its own (no TTL); `warm_up()` runs one tiny
    generation after a load so the first real turn doesn't pay for CUDA graph / kernel set-up;
  * flash attention, all layers on the GPU, KV cache type, context, parallel slots: Tony's production
    values from model_swap.rs (32768 x 2, flash attention, KV on the GPU).

Port 1236 is NOT used: G:\\ai-startup\\start-ai-stack.ps1 keeps it for a CPU Tony instance.

LoRA later (not built): llama-server's `--lora` + the per-request `lora` field fit this design, one
base model per process.
"""
from __future__ import annotations

import dataclasses
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine import install_llama  # noqa: E402

DATA_DIR = ROOT / "data" / "engine"
APP_CFG_DIR = Path(os.environ.get("APPDATA", str(Path.home()))) / "os.agentic.commandcenter"
SETTINGS_FILE = "engine.json"
_TONY_REL = Path("lmstudio-community") / "Qwen3.5-9B-GGUF" / "Qwen3.5-9B-Q4_K_M.gguf"
# The D: library copy first (Nic: models come from D:), else the LM Studio copy on C: that Bionic loads.
TONY_GGUF = next((p for p in (Path(r"D:\LM Studio") / _TONY_REL, Path.home() / ".lmstudio" / "models" / _TONY_REL)
                  if p.exists()), Path.home() / ".lmstudio" / "models" / _TONY_REL)
TONY_ALIAS = "qwen/qwen3.5-9b"  # the id Tony's providers.json entry already asks for
KV_TYPES = ("f16", "bf16", "q8_0", "q4_0", "q4_1", "q5_0", "q5_1", "iq4_nl", "f32")


@dataclass
class EngineSettings:
    enabled: bool = False                # master switch: OFF until Nic turns it on
    exe: str = str(install_llama.server_exe())
    host: str = "127.0.0.1"              # never 0.0.0.0: the gateway fronts the LAN / phone
    port: int = 1238
    model_path: str = str(TONY_GGUF)
    alias: str = TONY_ALIAS
    mmproj: str = ""                     # vision projector (optional, later: OCR)
    ctx: int = 32768                     # total context, shared by the slots
    parallel: int = 2
    gpu_layers: int = 999                # all of them
    flash_attn: bool = True
    kv_type_k: str = "f16"
    kv_type_v: str = "f16"
    cache_reuse: int = 256               # min chunk for prefix reuse via KV shifting (0 = off)
    prompt_cache: bool = True            # slot save/restore folder + cache_prompt
    keep_warm: bool = True               # warm-up generation after every load
    jinja: bool = True                   # the GGUF's own chat template (tool calls need it)
    # Thinking off unless a request turns it on. Qwen3.5's template reads only `enable_thinking`
    # (LM Studio maps `reasoning_effort`, llama-server does not), so without this every client that
    # only sends reasoning_effort (dispatch.rs) or nothing (n8n, Scene Reader) would think first.
    thinking_default: bool = False
    # Switchboard rows (Section 26), all OFF: nothing uses the engine until Nic turns one on.
    route_agents: bool = False           # gateway agents (engine/agent_runner.py) answer on the engine
    route_tony: bool = False             # gateway Tony answers on the engine instead of Bionic
    threads: int = 0                     # 0 = llama-server's default
    extra_args: list[str] = field(default_factory=list)

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}/v1"

    def validate(self) -> list[str]:
        bad = []
        if self.host not in ("127.0.0.1", "localhost", "::1"):
            bad.append("host must be loopback (the gateway is the only door in)")
        if not (1024 <= int(self.port) <= 65535) or int(self.port) in (1235, 1236, 1237, 8080, 8443):
            bad.append(f"port {self.port} is taken or reserved")
        if self.ctx < 512 or self.ctx > 262144:
            bad.append("ctx out of range")
        if self.parallel < 1 or self.parallel > 8:
            bad.append("parallel must be 1-8")
        for k in (self.kv_type_k, self.kv_type_v):
            if k not in KV_TYPES:
                bad.append(f"unknown KV cache type {k}")
        if self.kv_type_v != "f16" and not self.flash_attn:
            bad.append("a quantized V cache needs flash attention")
        if any(a in ("--host", "--port", "-m", "--model", "--api-key-file") for a in self.extra_args):
            bad.append("extra_args may not override host, port or model")
        return bad


def settings_path(cfg_dir: Optional[Path] = None) -> Path:
    return (cfg_dir or APP_CFG_DIR) / SETTINGS_FILE


def load_settings(cfg_dir: Optional[Path] = None) -> EngineSettings:
    """Defaults, overlaid with the known keys of engine.json (unknown keys and bad types ignored)."""
    s = EngineSettings()
    try:
        raw = json.loads(settings_path(cfg_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return s
    if not isinstance(raw, dict):
        return s
    for f in dataclasses.fields(s):
        if f.name in raw:
            cur, v = getattr(s, f.name), raw[f.name]
            if isinstance(cur, bool):
                ok = isinstance(v, bool)
            elif isinstance(cur, int):
                ok = isinstance(v, int) and not isinstance(v, bool)
            elif isinstance(cur, list):
                ok = isinstance(v, list) and all(isinstance(x, str) for x in v)
            else:
                ok = isinstance(v, str)
            if ok:
                setattr(s, f.name, v)
    return s


def save_settings(s: EngineSettings, cfg_dir: Optional[Path] = None) -> Path:
    bad = s.validate()
    if bad:
        raise ValueError("; ".join(bad))
    p = settings_path(cfg_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(dataclasses.asdict(s), indent=2), encoding="utf-8")
    tmp.replace(p)
    return p


def build_args(s: EngineSettings, model_path: Optional[str] = None) -> list[str]:
    """llama-server's command line (without the exe)."""
    a = ["-m", model_path or s.model_path, "--host", s.host, "--port", str(s.port), "-a", s.alias,
         "-c", str(s.ctx), "-np", str(s.parallel), "-ngl", str(s.gpu_layers),
         "-fa", "on" if s.flash_attn else "off", "-ctk", s.kv_type_k, "-ctv", s.kv_type_v,
         "--no-webui", "--log-colors", "off", "--metrics"]
    if s.jinja:
        a.append("--jinja")
        if not s.thinking_default:
            a += ["--chat-template-kwargs", '{"enable_thinking":false}']
    if s.cache_reuse > 0:
        a += ["--cache-reuse", str(s.cache_reuse)]
    if s.prompt_cache:
        a += ["--slot-save-path", str(DATA_DIR / "slots")]
    if s.mmproj:
        a += ["--mmproj", s.mmproj]
    if s.threads > 0:
        a += ["-t", str(s.threads)]
    return a + list(s.extra_args)


def _get(url: str, timeout: float = 3.0) -> tuple[int, Any]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(body) if body.strip().startswith(("{", "[")) else body)
    except urllib.error.HTTPError as e:
        return e.code, None


class EngineRefused(RuntimeError):
    pass


class Engine:
    """Starts / stops the one llama-server. The pid is kept in data/engine/engine.pid so another
    process (the gateway, a CLI) can see and stop the same server; it only ever stops a pid that is
    still a llama-server it started (exe path checked)."""

    def __init__(self, settings: Optional[EngineSettings] = None, data_dir: Optional[Path] = None,
                 http_get: Callable = _get, popen: Callable = subprocess.Popen):
        self.s = settings or load_settings()
        self.data = data_dir or DATA_DIR  # read at call time (tests and the gateway may repoint it)
        self._get = http_get
        self._popen = popen

    # ── state ──
    @property
    def pid_file(self) -> Path:
        return self.data / "engine.pid"

    def _pid_info(self) -> Optional[dict]:
        try:
            return json.loads(self.pid_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def health(self) -> str:
        """'ok', 'loading' (503 while the model loads), 'error', or 'down'."""
        try:
            code, _ = self._get(f"http://{self.s.host}:{self.s.port}/health", 2.0)
        except Exception:
            return "down"
        return {200: "ok", 503: "loading"}.get(code, "error")

    def status(self) -> dict:
        info = self._pid_info() or {}
        return {"enabled": self.s.enabled, "health": self.health(), "baseUrl": self.s.base_url,
                "pid": info.get("pid"), "model": info.get("model"), "alias": info.get("alias"),
                "startedAt": info.get("startedAt")}

    # ── start / stop ──
    def start(self, model_path: Optional[str] = None, alias: Optional[str] = None, *, force: bool = False,
              wait_s: float = 180.0, sleep: Callable[[float], None] = time.sleep) -> dict:
        if not (self.s.enabled or force):
            raise EngineRefused("the built-in engine is off (engine.json enabled=false)")
        bad = self.s.validate()
        if bad:
            raise EngineRefused("; ".join(bad))
        model = model_path or self.s.model_path
        if not Path(self.s.exe).exists():
            raise EngineRefused(f"llama-server not installed at {self.s.exe} (python -m engine.install_llama)")
        if not Path(model).exists():
            raise EngineRefused(f"model not found: {model}")
        if self.health() != "down":
            raise EngineRefused(f"something already answers on port {self.s.port}; stop it first")
        logs = self.data / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        (self.data / "slots").mkdir(parents=True, exist_ok=True)
        err = logs / "llama-server.err.log"
        if err.exists():  # keep the previous run's log once (a crash's log survives a restart)
            err.replace(err.with_suffix(".log.1"))
        s = dataclasses.replace(self.s, alias=alias or self.s.alias)
        args = [self.s.exe, *build_args(s, model)]
        flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
        with err.open("wb") as ef:
            proc = self._popen(args, stdout=subprocess.DEVNULL, stderr=ef, stdin=subprocess.DEVNULL,
                               cwd=str(Path(self.s.exe).parent), creationflags=flags)
        info = {"pid": proc.pid, "exe": self.s.exe, "model": model, "alias": s.alias,
                "args": args[1:], "startedAt": time.time()}
        self.data.mkdir(parents=True, exist_ok=True)
        self.pid_file.write_text(json.dumps(info, indent=2), encoding="utf-8")
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"llama-server exited with {proc.returncode}; see {err}")
            if self.health() == "ok":
                if self.s.keep_warm:
                    self.warm_up(s.alias)
                return self.status()
            sleep(0.5)
        raise TimeoutError(f"llama-server not healthy after {wait_s:.0f} s; see {err}")

    def warm_up(self, alias: Optional[str] = None) -> bool:
        body = json.dumps({"model": alias or self.s.alias, "max_tokens": 1, "stream": False,
                           "messages": [{"role": "user", "content": "hi"}],
                           "chat_template_kwargs": {"enable_thinking": False}}).encode()
        req = urllib.request.Request(f"{self.s.base_url}/chat/completions", data=body,
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60):
                return True
        except Exception:
            return False

    def stop(self, kill: Callable[[int], None] | None = None, is_ours: Callable[[int, str], bool] | None = None) -> bool:
        """Stop the server this engine started. False when nothing of ours is running."""
        info = self._pid_info()
        if not info:
            return False
        pid, exe = int(info.get("pid") or 0), str(info.get("exe") or "")
        if pid and (is_ours or _is_process_exe)(pid, exe):
            (kill or _kill)(pid)
        try:
            self.pid_file.unlink()
        except OSError:
            pass
        return bool(pid)


def _is_process_exe(pid: int, exe: str) -> bool:
    """True when `pid` is alive and its image is `exe` (so a recycled pid is never killed)."""
    if os.name != "nt":
        try:
            return os.path.samefile(os.readlink(f"/proc/{pid}/exe"), exe)
        except OSError:
            return False
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", f"(Get-Process -Id {pid} -ErrorAction Stop).Path"],
                             capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return False
    return bool(out) and os.path.normcase(os.path.abspath(out)) == os.path.normcase(os.path.abspath(exe))


def _kill(pid: int) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=15)
    else:
        os.kill(pid, 15)


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="the built-in llama.cpp engine")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    st = sub.add_parser("start")
    st.add_argument("--model", default="")
    st.add_argument("--force", action="store_true", help="start although engine.json has enabled=false (approved tests only)")
    sub.add_parser("stop")
    sub.add_parser("args", help="print the llama-server command line")
    a = ap.parse_args(argv)
    eng = Engine()
    if a.cmd == "status":
        print(json.dumps(eng.status(), indent=2))
    elif a.cmd == "args":
        print(" ".join([eng.s.exe, *build_args(eng.s)]))
    elif a.cmd == "start":
        print(json.dumps(eng.start(a.model or None, force=a.force), indent=2))
    elif a.cmd == "stop":
        print("stopped" if eng.stop() else "nothing to stop")
    return 0


if __name__ == "__main__":
    sys.exit(main())
