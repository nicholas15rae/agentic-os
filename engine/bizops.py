"""Biz Ops prompt builder (Section 26, Nic 11-27): one shared prompt + ONLY the tagged business's section.

The text lives in docs/section-26-bizops-prompt.md (Nic's draft): the ```text block under
"## Shared part" and one ```text block per "### `<businessId>`" heading. build_prompt(tag):
  * refuses a missing / unknown tag (the gateway then has Tony ask Nic which business)
  * refuses a business that isn't `active` in businesses.json unless allow_provisioning
  * fills {business}, {business_name}, {business_section}
  * checks no OTHER business's display name, id or aliases appear in the result (scope bleed),
    the same idea as the registry's crossDomainBlocklist
Not wired into any request path yet.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DRAFT = ROOT / "docs" / "section-26-bizops-prompt.md"
REGISTRY = Path(os.environ.get("APPDATA", str(Path.home()))) / "os.agentic.commandcenter" / "businesses.json"


class BizOpsRefused(ValueError):
    pass


def parse_draft(text: str) -> tuple[str, dict[str, str]]:
    """(shared template, {businessId: section text}) from the draft markdown."""
    text = "\n".join(text.splitlines())  # the working copy may be CRLF (core.autocrlf)
    blocks = re.findall(r"(^#{2,3} [^\n]*$)|```text\n(.*?)```", text, re.M | re.S)
    shared, sections, heading = "", {}, ""
    for h, body in blocks:
        if h:
            heading = h
            continue
        if heading.startswith("## Shared"):
            shared = body.strip()
        else:
            m = re.match(r"### `([a-z0-9_]+)`", heading)
            if m:
                sections[m.group(1)] = body.strip()
    if not shared or "{business_section}" not in shared:
        raise BizOpsRefused("draft has no shared part with {business_section}")
    return shared, sections


def load_registry(path: Path = REGISTRY) -> list[dict]:
    d = json.loads(path.read_text(encoding="utf-8"))
    bs = d.get("businesses", d) if isinstance(d, dict) else d
    return list(bs.values()) if isinstance(bs, dict) else list(bs)


def _terms(b: dict) -> list[str]:
    return [t for t in [b.get("businessId", ""), b.get("displayName", ""), *(b.get("aliases") or [])] if t and len(t) >= 4]


def build_prompt(tag: Optional[str], registry: list[dict], draft_text: str, *, allow_provisioning: bool = False) -> str:
    if not tag:
        raise BizOpsRefused("no business tag: ask Nic which business")
    by_id = {b.get("businessId"): b for b in registry}
    b = by_id.get(tag)
    if not b:
        raise BizOpsRefused(f"unknown business '{tag}'")
    if b.get("status") != "active" and not allow_provisioning:
        raise BizOpsRefused(f"business '{tag}' is {b.get('status')}, not active")
    shared, sections = parse_draft(draft_text)
    if tag not in sections:
        raise BizOpsRefused(f"the draft has no section for '{tag}'")
    out = shared.replace("{business_section}", sections[tag]).replace("{business_name}", b.get("displayName", tag)).replace("{business}", tag)
    low = out.lower()
    own = {t.lower() for t in _terms(b)}
    for other in registry:
        if other.get("businessId") == tag:
            continue
        for t in _terms(other):
            tl = t.lower()
            if tl in own:
                continue  # a word both businesses share (e.g. 'bookings') can't identify the other one
            if re.search(r"(?<![a-z0-9])" + re.escape(tl) + r"(?![a-z0-9])", low):
                raise BizOpsRefused(f"section for '{tag}' mentions another business ({other.get('businessId')}: '{t}')")
    return out


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="print the Biz Ops prompt for one business tag")
    ap.add_argument("tag")
    ap.add_argument("--allow-provisioning", action="store_true")
    a = ap.parse_args(argv)
    print(build_prompt(a.tag, load_registry(), DRAFT.read_text(encoding="utf-8"), allow_provisioning=a.allow_provisioning))
    return 0


if __name__ == "__main__":
    sys.exit(main())
