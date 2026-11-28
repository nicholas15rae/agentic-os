"""Chat-template and tool-call checks for the built-in engine (Section 26 item 11), Qwen first.

Static (no server): renders the GGUF's OWN chat template (tokenizer.chat_template, the one
llama-server uses with --jinja) and checks
  * thinking off really emits the empty think block (`enable_thinking` is the only switch this
    template reads: `reasoning_effort` is ignored, so the engine sets enable_thinking=false by default)
  * tools render in the template's own format (Qwen3.5: <tool_call><function=…><parameter=…>)
  * prompt-cache friendliness: turn N's rendered prompt is a byte prefix of turn N+1's, so
    llama-server's prefix reuse (--cache-reuse) can skip re-reading the history

Live (optional, any OpenAI-compatible server: Bionic today, the engine later):
  * a plain turn with thinking off answers with no reasoning text
  * a native `tools` request comes back as a parsed tool_calls entry with valid JSON arguments
  * a JSON-router-style turn (how Tony picks tools today) returns parseable JSON

    python -m engine.template_check                       # static, Tony's GGUF
    python -m engine.template_check --live lmstudio       # + live on Bionic (Tony's model must be loaded)
    python -m engine.template_check --live engine         # + live on the engine (:1238)
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine import gguf_meta  # noqa: E402
from engine.llama_engine import TONY_GGUF  # noqa: E402

WEATHER_TOOL = {"type": "function", "function": {
    "name": "get_weather", "description": "Current weather for a city",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}

CONVO = [
    {"role": "system", "content": "You are Tony, Nic's assistant. Be brief."},
    {"role": "user", "content": "hey tony"},
    {"role": "assistant", "content": "Hey Nic, what's up?"},
    {"role": "user", "content": "what's the weather in Toronto?"},
    {"role": "assistant", "content": "Let me check.", "tool_calls": [
        {"type": "function", "function": {"name": "get_weather", "arguments": {"city": "Toronto"}}}]},
    {"role": "tool", "content": "{\"temp_c\": 3, \"sky\": \"cloudy\"}"},
    {"role": "assistant", "content": "3 degrees and cloudy."},
    {"role": "user", "content": "thanks"},
]


def _env():
    import jinja2
    from jinja2.sandbox import ImmutableSandboxedEnvironment

    def raise_exception(msg):
        raise jinja2.TemplateError(msg)

    env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True, extensions=["jinja2.ext.loopcontrols"])
    env.filters["tojson"] = lambda v, indent=None, ensure_ascii=False, **kw: json.dumps(v, indent=indent, ensure_ascii=ensure_ascii)
    env.globals["raise_exception"] = raise_exception
    env.globals["strftime_now"] = lambda fmt: time.strftime(fmt)
    return env


def render(template: str, messages: list[dict], *, tools=None, thinking: bool = False, add_generation_prompt: bool = True) -> str:
    t = _env().from_string(template)
    return t.render(messages=messages, tools=tools, enable_thinking=thinking, add_generation_prompt=add_generation_prompt,
                    bos_token="", eos_token="<|im_end|>")


def static_checks(template: str) -> list[dict]:
    out = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        out.append({"check": name, "ok": bool(ok), "detail": detail})

    off = render(template, CONVO[:2], thinking=False)
    on = render(template, CONVO[:2], thinking=True)
    check("thinking off emits an empty think block", off.rstrip().endswith("</think>") and "<think>" in off[-40:],
          repr(off[-60:]))
    check("thinking on leaves the think block open", not on.rstrip().endswith("</think>"), repr(on[-40:]))
    check("template reads enable_thinking (not reasoning_effort)",
          "enable_thinking" in template and "reasoning_effort" not in template)
    with_tools = render(template, CONVO[:4], tools=[WEATHER_TOOL])
    check("tools render with the model's own call format", "<tools>" in with_tools and "get_weather" in with_tools
          and ("<tool_call>" in with_tools), "Qwen XML: <tool_call><function=...><parameter=...>"
          if "<function=" in with_tools else "JSON-in-<tool_call>")
    full = render(template, CONVO, tools=[WEATHER_TOOL])
    check("tool call + tool result history render", "<tool_response>" in full and "get_weather" in full)
    # Prefix stability: the prompt for turn k (without the generation prompt) must be a prefix of
    # the prompt for any later turn, or llama-server re-reads the history every turn.
    breaks = []
    for k in (2, 4, 6):
        a = render(template, CONVO[:k], add_generation_prompt=False)
        b = render(template, CONVO[:k + 2], add_generation_prompt=False)
        if not b.startswith(a):
            i = next((j for j, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
            breaks.append(f"turn {k}: differs at char {i}: {a[max(0, i - 30):i + 30]!r} vs {b[max(0, i - 30):i + 30]!r}")
    check("history prefix is byte-stable turn to turn (prompt cache reuse)", not breaks, "; ".join(breaks)[:600])
    # Qwen3.5's template keeps the empty think block only on the assistant turn(s) after the last
    # user message, so the previous exchange re-renders on the next turn: llama-server re-reads that
    # exchange (the system prompt and older history stay cached). Same template in LM Studio, so
    # not a regression: a warning, not a failure.
    out[-1]["severity"] = "warn"
    return out


def _post(base: str, body: dict, timeout: float = 90.0) -> dict:
    req = urllib.request.Request(f"{base.rstrip('/')}/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def live_checks(base: str, model: str, post=_post) -> list[dict]:
    out = []
    off = {"reasoning_effort": "none", "chat_template_kwargs": {"enable_thinking": False}}

    def check(name, fn):
        t0 = time.monotonic()
        try:
            ok, detail = fn()
        except Exception as e:
            ok, detail = False, f"{type(e).__name__}: {e}"[:300]
        out.append({"check": name, "ok": ok, "detail": detail, "secs": round(time.monotonic() - t0, 2)})

    def plain():
        r = post(base, {"model": model, "max_tokens": 60, "messages": CONVO[:2], **off})
        msg = r["choices"][0]["message"]
        content, reasoning = msg.get("content") or "", msg.get("reasoning_content") or ""
        return bool(content.strip()) and "<think>" not in content and not reasoning.strip(), f"content={content[:80]!r} reasoning={len(reasoning)} chars"

    def native_tools():
        r = post(base, {"model": model, "max_tokens": 200, "tools": [WEATHER_TOOL], "tool_choice": "auto",
                        "messages": [CONVO[0], {"role": "user", "content": "What's the weather in Toronto right now?"}], **off})
        calls = r["choices"][0]["message"].get("tool_calls") or []
        if not calls:
            return False, f"no tool_calls; content={(r['choices'][0]['message'].get('content') or '')[:120]!r}"
        fn = calls[0]["function"]
        args = json.loads(fn["arguments"]) if isinstance(fn["arguments"], str) else fn["arguments"]
        return fn["name"] == "get_weather" and str(args.get("city", "")).lower().startswith("toronto"), f"{fn['name']}({args})"

    def json_router():
        sysmsg = ("Pick the tool for the user's line. Reply with JSON only: "
                  '{"tool": "<one of: weather.current, time.now, none>", "args": {}}')
        r = post(base, {"model": model, "max_tokens": 80, "temperature": 0,
                        "messages": [{"role": "system", "content": sysmsg}, {"role": "user", "content": "is it raining in Toronto?"}], **off})
        content = (r["choices"][0]["message"].get("content") or "").strip()
        m = re.search(r"\{.*\}", content, re.S)
        parsed = json.loads(m.group(0)) if m else None
        return bool(parsed) and parsed.get("tool") == "weather.current", content[:120]

    check("plain turn, thinking off: answer and no reasoning", plain)
    check("native tools: parsed tool_calls with JSON arguments", native_tools)
    check("JSON router turn returns the right tool as JSON", json_router)
    return out


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--gguf", default=str(TONY_GGUF))
    ap.add_argument("--live", choices=("lmstudio", "engine"))
    a = ap.parse_args(argv)
    meta = gguf_meta.read_meta(a.gguf)
    tpl = meta.get("tokenizer.chat_template")
    if not isinstance(tpl, str):
        print("this GGUF has no chat template")
        return 1
    results = {"gguf": a.gguf, "static": static_checks(tpl)}
    if a.live:
        import gateway_tony as gt
        from engine.bench_tony import ENGINE_BASE, preflight
        model, base = gt.tony_model()
        if a.live == "engine":
            base = ENGINE_BASE
        why = preflight(a.live, base, model, model_state=lambda b, m: gt.model_state(gt.bionic_root(b), m))
        if why:
            results["live"] = f"REFUSED: {why}"
        else:
            results["live"] = {"target": a.live, "base": base, "model": model, "checks": live_checks(base, model)}
    print(json.dumps(results, indent=2, ensure_ascii=False))
    ok = all(c["ok"] or c.get("severity") == "warn" for c in results["static"]) and (not isinstance(results.get("live"), dict) or all(c["ok"] for c in results["live"]["checks"]))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
