"""Propose the gateway's own agent table from today's config (Section 26 item 10). Read-only.

Reads os.json (routing.agents, the AnythingLLM workspace map, the MCP registry, skill grants, the
switchboard) and an AnythingLLM export (engine/allm_import.py: workspace prompt, model, temperature,
history, threads) and writes ONE proposal:

    data/engine/agents.proposed.json   (gitignored: it holds Nic's prompts)

Each agent becomes {prompt, promptSource, model, temperature, history, tools[], readOnlyTools[],
skills[], memory{workspace, threads, chats, documents}, frozen, notes[]}, calling the shared model
directly. Tools come only from Tony's MCP registry (`mcps[].agents` grants). Nothing is wired: the
gateway does not read this file yet; switching an agent over is a later, switchboard-gated step.

Decisions it does NOT make (listed under `questions`): a tool granted to several agents ("one owner
per tool" is Nic's rule, but which agent owns it is his call), agents with no prompt anywhere, and
workspaces that map to removed agents (Ops).
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

OS_JSON = Path(os.environ.get("APPDATA", str(Path.home()))) / "os.agentic.commandcenter" / "os.json"
OUT = ROOT / "data" / "engine" / "agents.proposed.json"
BUILTIN_PROMPTS = {"prompter", "designer", "coder", "librarian"}  # agent_prompts.rs role_prompt
# Nic 11-27: Tony's gateway prompt is the only Tony prompt. The AnythingLLM workspace os.json maps
# to Tony ("general" -> my-workspace) actually holds the detailed Booking Desk prompt (casting posts,
# Gmail drafts, templates A/B); the "booking" workspace has only a short generic one. So Booking takes
# my-workspace's prompt (pending Nic's OK) and nothing from it goes into Tony's.
PROMPT_FROM = {"booking": "my-workspace"}
# Nic 11-27: one shared Biz Ops prompt with a section per business, picked by the business tag.
BIZOPS_DRAFT = "docs/section-26-bizops-prompt.md (DRAFT, Nic reviews)"
BIZOPS_WORKSPACES = ("bizops_trades_contracting", "bizops_supplements_ecom", "bizops_acting")
REMOVED = {"ops"}  # Ops agent removed 11-26 (its work is Tony's)

# Nic's tool owners (11-27): one owner gets write access; named readers get read-only, optionally
# limited to folders; everyone else loses the tool. Tools not listed keep their single grant as the
# owner. "general" is Tony.
TOOL_POLICY: dict[str, dict] = {
    "filesystem": {"owner": "coder",
                   "readers": {"director": [r"G:\ai-hub\media\projects"],
                               "designer": []}},  # no Designer project folder exists yet: Nic names it
    "fetch": {"owner": "coder", "readers": {}},  # Tony uses Brave Search instead
    "knowledge-graph": {"owner": "general", "readers": {"librarian": None, "prompter": None}},  # None = no folder limit
}


def _export_workspaces(export_dir: Path) -> dict[str, dict]:
    c = sqlite3.connect(f"file:{(export_dir / 'anythingllm.db').as_posix()}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        out = {}
        for w in c.execute("SELECT * FROM workspaces"):
            w = dict(w)
            wid = w["id"]
            out[w["slug"]] = {
                "name": w.get("name"), "prompt": w.get("openAiPrompt") or "", "model": w.get("chatModel"),
                "temperature": w.get("openAiTemp"), "history": w.get("openAiHistory"),
                "threads": c.execute("SELECT COUNT(*) FROM workspace_threads WHERE workspace_id=?", (wid,)).fetchone()[0],
                "chats": c.execute("SELECT COUNT(*) FROM workspace_chats WHERE workspaceId=?", (wid,)).fetchone()[0],
                "documents": c.execute("SELECT COUNT(*) FROM workspace_documents WHERE workspaceId=?", (wid,)).fetchone()[0],
            }
        return out
    finally:
        c.close()


def propose(os_cfg: dict, export: dict[str, dict]) -> dict:
    agents_cfg = (os_cfg.get("routing") or {}).get("agents") or {}
    ws_map = (os_cfg.get("anythingllm") or {}).get("workspaces") or {}
    mcps = [m for m in (os_cfg.get("mcps") or []) if isinstance(m, dict)]
    grants = (os_cfg.get("skills") or {}).get("grants") or {}
    frozen = set(((os_cfg.get("switchboard") or {}).get("frozenAgents")) or [])
    names = sorted(set(agents_cfg) | set(ws_map))
    agents, questions = {}, []
    for a in names:
        slug = ws_map.get(a)
        ws = export.get(slug or "", {})
        prompt_ws = PROMPT_FROM.get(a)
        if prompt_ws and export.get(prompt_ws, {}).get("prompt"):
            ws = {**ws, "prompt": export[prompt_ws]["prompt"], "promptFrom": prompt_ws}
        access = []
        for m in mcps:
            if not m.get("enabled", True):
                continue
            tid, pol = m["id"], TOOL_POLICY.get(m["id"])
            if pol:
                if a == pol["owner"]:
                    access.append({"tool": tid, "access": "read" if m.get("readOnly") else "write"})
                elif a in pol["readers"]:
                    roots = pol["readers"][a]
                    access.append({"tool": tid, "access": "read", **({"roots": roots} if roots is not None else {})})
            elif a in (m.get("agents") or []):
                access.append({"tool": tid, "access": "read" if m.get("readOnly") else "write"})
        tools = [x["tool"] for x in access]
        ro = [x["tool"] for x in access if x["access"] == "read"]
        notes = []
        if a == "bizops":
            src, prompt = f"shared Biz Ops prompt: {BIZOPS_DRAFT}", None
            notes.append("maps the business workspaces: " + ", ".join(w for w in BIZOPS_WORKSPACES if w in export or w == "bizops_acting"))
        elif a in BUILTIN_PROMPTS:
            src, prompt = "agent_prompts.rs role_prompt (built in)", None
            if ws.get("prompt"):
                notes.append("AnythingLLM carries a copy of the built-in prompt; the built-in one wins")
        elif a == "general":
            src, prompt = "Tony's gateway prompt (gateway_tony.system_prompt), the only Tony prompt", None
            if ws.get("prompt"):
                notes.append(f"AnythingLLM workspace '{slug}' holds a non-Tony prompt; not merged into Tony's")
        elif ws.get("prompt"):
            src, prompt = f"anythingllm:{ws.get('promptFrom') or slug}", ws["prompt"]
            if ws.get("promptFrom"):
                notes.append(f"prompt taken from workspace '{ws['promptFrom']}' (the detailed one), not '{slug}': Nic to confirm")
        else:
            src, prompt = "none", None
            questions.append(f"agent '{a}' has no prompt anywhere (no built-in, empty AnythingLLM workspace '{slug}')")
        if a in REMOVED:
            notes.append("removed agent (11-26): not migrated; its workspace stays in the export")
        agents[a] = {
            "names": (agents_cfg.get(a) or {}).get("names", []), "domains": (agents_cfg.get(a) or {}).get("domains", []),
            "promptSource": src, "prompt": prompt, "model": ws.get("model"), "temperature": ws.get("temperature"),
            "history": ws.get("history"), "tools": tools, "readOnlyTools": ro, "toolAccess": access,
            "skills": sorted(k for k, v in grants.items() if a in (v or [])),
            "memory": {"workspace": slug, "threads": ws.get("threads", 0), "chats": ws.get("chats", 0), "documents": ws.get("documents", 0)},
            "frozen": a in frozen, "migrate": a not in REMOVED, "notes": notes,
        }
    for m in mcps:
        owners = [x for x in (m.get("agents") or []) if x not in REMOVED]
        if len(owners) > 1 and m["id"] not in TOOL_POLICY:
            questions.append(f"tool '{m['id']}' is granted to {len(owners)} agents ({', '.join(owners)}): which one owns it?")
    for tid, pol in TOOL_POLICY.items():
        for reader, roots in pol["readers"].items():
            if roots == []:
                questions.append(f"'{tid}' read-only for {reader}: which project folder? (no access until named)")
    unmapped = sorted(set(export) - set(ws_map.values()) - set(BIZOPS_WORKSPACES) - set(PROMPT_FROM.values()))
    if unmapped:
        questions.append(f"AnythingLLM workspaces no agent maps to (kept in the export, not migrated): {', '.join(unmapped)}")
    return {"agents": agents, "questions": questions, "tools": {m["id"]: m.get("agents", []) for m in mcps}}


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("export_dir")
    ap.add_argument("--os-json", default=str(OS_JSON))
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args(argv)
    os_cfg = json.loads(Path(a.os_json).read_text(encoding="utf-8"))
    res = propose(os_cfg, _export_workspaces(Path(a.export_dir)))
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf-8")
    for name, ag in res["agents"].items():
        print(f"{name:10} prompt={ag['promptSource'][:40]:40} tools={','.join(ag['tools']) or '-':45} frozen={ag['frozen']} migrate={ag['migrate']}")
    print("\nQuestions:")
    for q in res["questions"]:
        print(" -", q)
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
