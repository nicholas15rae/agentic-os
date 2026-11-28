"""LM Studio transport for the distiller. Strictly sequential, already-loaded model only.

- `loaded_chat_model` reads `GET /api/v0/models` and returns the first entry with `state == "loaded"`
  and type llm/vlm. It never falls back to the plain model listing (that order could JIT-load a model).
  Section 26: when `base` is the built-in engine with Tony's switch on, its /health answers instead.
- `chat` sends exactly one chat completion for that model id, under a module lock.
- `busy_reason` is the D8 idle check for a standalone run.
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from typing import List, Mapping, Optional

from . import net

HOST_SLOT_TOKEN = "memory · compact"
_SEQ = threading.Lock()
_THINK = re.compile(r"<think>.*?</think>", re.S | re.I)


def api_root(base: str) -> str:
    b = base.rstrip("/")
    return b[: -len("/v1")] if b.endswith("/v1") else b


def _engine_alias(base: str, timeout: float) -> Optional[str]:
    """Section 26: `base` is the built-in engine while Tony's switch is on (engine.json
    enabled + route_tony): llama-server serves exactly one model and never JIT-loads, so its
    /health is the "loaded" check. Anything else (switch off, another URL): None."""
    try:
        from engine.llama_engine import load_settings
        s = load_settings()
    except Exception:
        return None
    if not (s.enabled and s.route_tony) or base.rstrip("/") != s.base_url.rstrip("/"):
        return None
    try:
        h = net.get_json(f"{api_root(base)}/health", timeout=timeout)
    except Exception:
        return None
    return s.alias if isinstance(h, dict) and h.get("status") == "ok" else None


def loaded_chat_model(base: str, timeout: float = 4.0) -> Optional[str]:
    alias = _engine_alias(base, timeout)
    if alias:
        return alias
    try:
        data = net.get_json(f"{api_root(base)}/api/v0/models", timeout=timeout)
    except Exception:
        return None
    items = data.get("data") if isinstance(data, dict) else None
    for m in items or []:
        if isinstance(m, dict) and m.get("state") == "loaded" and m.get("type") in ("llm", "vlm") and isinstance(m.get("id"), str):
            return m["id"]
    return None


def strip_think(text: str) -> str:
    t = _THINK.sub("", text or "")
    if "</think>" in t.lower():
        t = t[t.lower().rindex("</think>") + len("</think>"):]
    return t.strip()


class LiveLLM:
    """One chat completion per call against the loaded model."""

    mode = "live"
    # The largest live distill completion seen was ~1.5k tokens; prompts run ~4.4k of a 16k context.
    MAX_TOKENS = 3072

    def __init__(self, base: str, model: str, timeout: float = 300.0):
        self.base = base
        self.model = model
        self.timeout = timeout
        self.calls = 0
        self.last_finish: Optional[str] = None  # finish_reason of the last reply ("length" = cut off)

    def chat(self, messages: List[dict]) -> str:
        body = {"model": self.model, "temperature": 0.2, "max_tokens": self.MAX_TOKENS, "reasoning_effort": "none", "messages": messages}
        self.last_finish = None
        with _SEQ:
            self.calls += 1
            data = net.send_json(f"{api_root(self.base)}/v1/chat/completions", body, timeout=self.timeout)
        try:
            choice = data["choices"][0]
            fr = choice.get("finish_reason")
            self.last_finish = fr if isinstance(fr, str) else None
            return strip_think(choice["message"]["content"] or "")
        except (KeyError, IndexError, TypeError, AttributeError):
            return ""


class ReplayLLM:
    """Canned replies (`--replay-llm FILE`): a JSON list of strings or objects. Never contacts a server."""

    mode = "replay"

    def __init__(self, replies: list, model: str = "replay"):
        self.replies = list(replies)
        self.model = model
        self.calls = 0
        self.last_finish: Optional[str] = None

    @classmethod
    def from_file(cls, path: Path) -> "ReplayLLM":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(data, list):
            raise ValueError("--replay-llm file must hold a JSON list")
        return cls(data)

    def chat(self, messages: List[dict]) -> str:
        with _SEQ:
            self.calls += 1
            if not self.replies:
                return ""
            r = self.replies.pop(0)
        return strip_think(r if isinstance(r, str) else json.dumps(r))


def gateway_gpu(gateway_base: str, timeout: float = 3.0):
    """(reachable, active, holder)."""
    try:
        d = net.get_json(f"{gateway_base.rstrip('/')}/api/os/gpu", timeout=timeout)
    except Exception:
        return False, False, ""
    if not isinstance(d, dict):
        return False, False, ""
    return True, bool(d.get("active")), str(d.get("holder") or "")[:60]


def busy_reason(env: Mapping[str, str], gateway_base: str, assume_idle: bool = False) -> Optional[str]:
    """None when compaction may use the GPU now (D8), else a short reason."""
    if (env.get("AOS_GPU_SLOT_HELD") or "") == HOST_SLOT_TOKEN:
        return None
    reachable, active, holder = gateway_gpu(gateway_base)
    if reachable:
        return f"gpu busy ({holder or 'desktop'})" if active else None
    if assume_idle:
        return None
    return "gateway unreachable; cannot confirm the GPU is idle (pass --assume-idle to override)"
