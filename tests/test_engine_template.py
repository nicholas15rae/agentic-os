"""engine/template_check.py on a small Qwen-style template (no GGUF, no server) and the live checks
with a fake server; plus the engine's thinking-off default on the command line."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import llama_engine as le  # noqa: E402
from engine import template_check as tc  # noqa: E402

# A cut-down Qwen3.5 template: tools block, XML tool calls, empty think block when thinking is off,
# think blocks only after the last user turn (the real template's behaviour).
MINI = """{%- if tools %}<|im_start|>system
<tools>{% for t in tools %}{{ t | tojson }}{% endfor %}</tools>
<tool_call>
<function=example>
</function>
</tool_call><|im_end|>
{% endif %}
{%- set ns = namespace(last_user=0) %}{% for m in messages %}{% if m.role == 'user' %}{% set ns.last_user = loop.index0 %}{% endif %}{% endfor %}
{%- for m in messages %}
{%- if m.role == 'assistant' %}<|im_start|>assistant
{% if loop.index0 > ns.last_user %}<think>

</think>

{% endif %}{{ m.content }}{% for c in m.tool_calls or [] %}<tool_call>
<function={{ c.function.name }}>
</function>
</tool_call>{% endfor %}<|im_end|>
{% elif m.role == 'tool' %}<|im_start|>user
<tool_response>{{ m.content }}</tool_response><|im_end|>
{% else %}<|im_start|>{{ m.role }}
{{ m.content }}<|im_end|>
{% endif %}
{%- endfor %}
{%- if add_generation_prompt %}<|im_start|>assistant
{% if not enable_thinking %}<think>

</think>

{% else %}<think>
{% endif %}{% endif %}"""


class StaticTests(unittest.TestCase):
    def test_checks_on_qwen_style_template(self):
        res = {c["check"]: c for c in tc.static_checks(MINI + "{# enable_thinking #}")}
        self.assertTrue(res["thinking off emits an empty think block"]["ok"])
        self.assertTrue(res["thinking on leaves the think block open"]["ok"])
        self.assertTrue(res["tools render with the model's own call format"]["ok"])
        self.assertIn("Qwen XML", res["tools render with the model's own call format"]["detail"])
        self.assertTrue(res["tool call + tool result history render"]["ok"])
        prefix = res["history prefix is byte-stable turn to turn (prompt cache reuse)"]
        self.assertEqual(prefix["severity"], "warn")
        self.assertFalse(prefix["ok"])  # the think block moves, as in the real template

    def test_sandboxed(self):
        with self.assertRaises(Exception):
            tc.render("{{ ''.__class__.__mro__[1].__subclasses__() }}", [{"role": "user", "content": "x"}])


class LiveTests(unittest.TestCase):
    def test_all_pass_on_a_well_behaved_server(self):
        def post(base, body, timeout=90):
            self.assertEqual(body["chat_template_kwargs"], {"enable_thinking": False})
            if "tools" in body:
                msg = {"content": "", "tool_calls": [{"function": {"name": "get_weather", "arguments": json.dumps({"city": "Toronto"})}}]}
            elif "JSON only" in body["messages"][0]["content"]:
                msg = {"content": '{"tool": "weather.current", "args": {"city": "Toronto"}}'}
            else:
                msg = {"content": "Hey Nic."}
            return {"choices": [{"message": msg}]}
        res = tc.live_checks("http://x/v1", "m", post=post)
        self.assertTrue(all(c["ok"] for c in res), res)

    def test_failures_are_reported_not_raised(self):
        def post(base, body, timeout=90):
            if "tools" in body:
                return {"choices": [{"message": {"content": "<tool_call><function=get_weather>"}}]}  # unparsed
            if "JSON only" in body["messages"][0]["content"]:
                raise TimeoutError("slow")
            return {"choices": [{"message": {"content": "Hi", "reasoning_content": "let me think..."}}]}
        res = {c["check"]: c for c in tc.live_checks("http://x/v1", "m", post=post)}
        self.assertFalse(any(c["ok"] for c in res.values()))
        self.assertIn("no tool_calls", res["native tools: parsed tool_calls with JSON arguments"]["detail"])
        self.assertIn("TimeoutError", res["JSON router turn returns the right tool as JSON"]["detail"])


class EngineThinkingDefault(unittest.TestCase):
    def test_off_by_default_on_the_command_line(self):
        a = le.build_args(le.EngineSettings(model_path="m"))
        self.assertEqual(a[a.index("--chat-template-kwargs") + 1], '{"enable_thinking":false}')
        self.assertNotIn("--chat-template-kwargs", le.build_args(le.EngineSettings(thinking_default=True)))
        self.assertNotIn("--chat-template-kwargs", le.build_args(le.EngineSettings(jinja=False)))


if __name__ == "__main__":
    unittest.main()
