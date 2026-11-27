"""Memory Scroll schema, frontmatter, templates, path validation, validation and merge. Pure (reads only).

The host owns the frontmatter; the model only ever returns the Markdown body. Writing a scroll
lives in `scroll_store.py` so this module stays free of any write path.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

from . import fsutil
from .errors import ScrollError
from .scrub import scrub

NEVER_TOUCH = frozenset({"my-workspace", "booking"})
REL_RE = re.compile(
    r"^(core/(identity_and_preferences|architecture_decisions)"
    r"|projects/[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?(--[a-z0-9-]{1,24})?"
    r"|patterns/lessons_and_fixes)\.md$"
)
ID_RE = re.compile(r"^(core|proj|pattern)-[a-z0-9][a-z0-9-]{0,62}$")
ARCH_RE = re.compile(r"^arch-\d{4}-\d{2}-\d{2}-\d{2,3}$")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$")
RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}

FM_KEYS = ("scroll_id", "category", "last_updated", "version", "source_archive_ids", "supersedes")
CATEGORIES = ("core", "project", "pattern")
SUPERSEDED = "Superseded Decisions"
SUB_SCROLLS = "Sub-scrolls"
LOCKED_HEADINGS = ("Locked Decisions", "Locked Design Decisions", "Standing Rules")
TEMPLATES = {
    "project": ["Current Milestone", "Locked Decisions", "Key Paths", "Active State", "Open Threads"],
    "identity": ["Identity", "Communication Preferences", "Hardware & Constraints", "Standing Rules"],
    "architecture": ["Ports & Services", "Repo Paths", "Locked Design Decisions", "Guardrails"],
    "pattern": ["Fixes", "Failure Modes", "Tool Quirks", "Proven Recipes"],
}
TARGET_BYTES = 3072
HARD_CAP_BYTES = 5120
MAX_IDS_INLINE = 24
MAX_SUPERSEDES = 24
MAX_SUPERSEDED_LINES = 8
MAX_SUB_SCROLLS = 4

ENTITY_TYPES = ("person", "project", "tool", "service", "decision", "path", "concept", "lesson")
REPLY_KEYS = {"target_scroll", "updated_markdown", "graph_entities_to_upsert", "superseded_facts"}
TOO_LARGE = "too large"

_BAD_TAG = re.compile(
    r"<\s*/?\s*(think|script|style|iframe|img|div|span|a|p|br|hr|html|body|head|object|embed|svg|form|input|button|link|meta|table|tr|td|th|ul|ol|li|h[1-6]|b|i|em|strong|code|pre|details|summary|video|audio|source)\b[^>]*>",
    re.I,
)


@dataclass(frozen=True)
class Target:
    rel: str
    scroll_id: str
    category: str
    kind: str
    title: str
    slug: Optional[str] = None
    topic: Optional[str] = None


@dataclass
class Scroll:
    scroll_id: str
    category: str
    last_updated: str
    version: int
    source_archive_ids: List[str] = field(default_factory=list)
    supersedes: List[str] = field(default_factory=list)
    body: str = ""


# ── targets and paths ───────────────────────────────────────────────────────


# H1 titles of known project slugs, and acronyms inside any other slug ("agentic-os" -> "Agentic OS",
# not "Agentic Os"). Cosmetic, but the title is embedded into the Librarian RAG.
TITLE_SLUGS = {"agentic-os": "Agentic OS", "ai-hub": "AI Hub", "scene-reader": "Scene Reader"}
TITLE_WORDS = {
    "os": "OS", "ai": "AI", "kg": "KG", "llm": "LLM", "api": "API", "mcp": "MCP", "ui": "UI", "ux": "UX", "cli": "CLI", "gpu": "GPU",
    "rag": "RAG", "tts": "TTS", "stt": "STT", "gcp": "GCP", "aws": "AWS", "n8n": "n8n", "ipc": "IPC", "pwa": "PWA", "hud": "HUD",
}


def _title_of(slug: str) -> str:
    if slug in TITLE_SLUGS:
        return TITLE_SLUGS[slug]
    return " ".join(TITLE_WORDS.get(w, w.capitalize()) for w in slug.split("-") if w)


def target_info(rel: str) -> Target:
    if not isinstance(rel, str) or not REL_RE.match(rel):
        raise ScrollError("not a canonical scroll path")
    if rel == "core/identity_and_preferences.md":
        return Target(rel, "core-identity-and-preferences", "core", "identity", "Identity and Preferences")
    if rel == "core/architecture_decisions.md":
        return Target(rel, "core-architecture-decisions", "core", "architecture", "Architecture Decisions")
    if rel == "patterns/lessons_and_fixes.md":
        return Target(rel, "pattern-lessons-and-fixes", "pattern", "pattern", "Lessons and Fixes")
    stem = rel[len("projects/"):-len(".md")]
    slug, _, topic = stem.partition("--")
    if slug in NEVER_TOUCH or stem in NEVER_TOUCH:
        raise ScrollError("Booking is never a scroll target")
    if slug in RESERVED or stem in RESERVED:
        raise ScrollError("reserved device name")
    scroll_id = f"proj-{stem}"
    if not ID_RE.match(scroll_id):
        raise ScrollError("scroll id too long")
    title = _title_of(slug) + (f" — {_title_of(topic)}" if topic else "")
    return Target(rel, scroll_id, "project", "project", title, slug, topic or None)


def project_rel(slug: str) -> str:
    return f"projects/{slug}.md"


def resolve_in_root(root: Path, rel: str) -> Path:
    """The absolute path of `rel` under `root`; rejects escapes, ADS, reserved names and links."""
    if any(c in rel for c in (":", "\\")) or ".." in rel.split("/"):
        raise ScrollError("path escapes the scrolls root")
    target_info(rel)
    root = Path(root)
    if fsutil.is_reparse(root):
        raise ScrollError("scrolls root is a link or junction")
    cur = root
    for part in rel.split("/"):
        cur = cur / part
        if fsutil.is_reparse(cur):
            raise ScrollError("a link or junction is in the scroll path")
    root_real = os.path.normcase(os.path.realpath(root))
    p_real = os.path.normcase(os.path.realpath(cur))
    if not (p_real.startswith(root_real.rstrip("\\/") + os.sep)):
        raise ScrollError("path escapes the scrolls root")
    return cur


def headings_for(t: Target, sub_scrolls: bool = False) -> List[str]:
    hs = list(TEMPLATES[t.kind])
    if sub_scrolls:
        hs.append(SUB_SCROLLS)
    return hs + [SUPERSEDED]


def template_body(t: Target) -> str:
    parts = [f"# {t.title}", ""]
    for h in headings_for(t):
        parts += [f"## {h}", ""]
    return "\n".join(parts).rstrip() + "\n"


def new_scroll(t: Target, now: str) -> Scroll:
    return Scroll(t.scroll_id, t.category, now, 0, [], [], template_body(t))


# ── frontmatter ─────────────────────────────────────────────────────────────


def _strip_comment(v: str) -> str:
    out = []
    q = False
    for i, c in enumerate(v):
        if c == '"' and (i == 0 or v[i - 1] != "\\"):
            q = not q
        if c == "#" and not q and (i == 0 or v[i - 1] in " \t"):
            break
        out.append(c)
    return "".join(out).strip()


def _split_flow(inner: str) -> List[str]:
    items, cur, q = [], [], False
    for i, c in enumerate(inner):
        if c == '"' and (i == 0 or inner[i - 1] != "\\"):
            q = not q
        if c == "," and not q:
            items.append("".join(cur).strip())
            cur = []
            continue
        cur.append(c)
    tail = "".join(cur).strip()
    if tail or items:
        items.append(tail)
    return items


def _value(raw: str):
    v = _strip_comment(raw)
    if v.startswith("["):
        if not v.endswith("]"):
            raise ScrollError("unterminated list")
        out = []
        for item in _split_flow(v[1:-1]):
            if not (len(item) >= 2 and item.startswith('"') and item.endswith('"')):
                raise ScrollError("list items must be quoted")
            try:
                out.append(json.loads(item))
            except ValueError:
                raise ScrollError("bad list item") from None
        return out
    if v.startswith('"'):
        try:
            s = json.loads(v)
        except ValueError:
            raise ScrollError("bad quoted string") from None
        if not isinstance(s, str):
            raise ScrollError("bad quoted string")
        return s
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    if not v or any(c in v for c in " \t[]{}\""):
        raise ScrollError("bad scalar")
    return v


def parse(text: str) -> Scroll:
    text = text.lstrip("﻿").replace("\r\n", "\n")
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        raise ScrollError("missing frontmatter")
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration:
        raise ScrollError("unterminated frontmatter") from None
    fm = {}
    for line in lines[1:end]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^([a-z_]+):(.*)$", line)
        if not m:
            raise ScrollError("bad frontmatter line")
        k = m.group(1)
        if k in fm:
            raise ScrollError(f"duplicate key {k}")
        if k not in FM_KEYS:
            raise ScrollError(f"unknown key {k}")
        fm[k] = _value(m.group(2))
    missing = [k for k in FM_KEYS if k not in fm]
    if missing:
        raise ScrollError(f"missing keys: {', '.join(missing)}")
    sid, cat, lu, ver = fm["scroll_id"], fm["category"], fm["last_updated"], fm["version"]
    if not isinstance(sid, str) or not ID_RE.match(sid):
        raise ScrollError("bad scroll_id")
    if cat not in CATEGORIES:
        raise ScrollError("bad category")
    if not isinstance(lu, str) or not ISO_RE.match(lu):
        raise ScrollError("bad last_updated")
    if not isinstance(ver, int) or isinstance(ver, bool) or ver < 1:
        raise ScrollError("version must be an int >= 1")
    ids, sup = fm["source_archive_ids"], fm["supersedes"]
    if not isinstance(ids, list) or not all(isinstance(x, str) and ARCH_RE.match(x) for x in ids):
        raise ScrollError("bad source_archive_ids")
    if not isinstance(sup, list) or not all(isinstance(x, str) and 0 < len(x) <= 80 for x in sup):
        raise ScrollError("bad supersedes")
    body = "\n".join(lines[end + 1:]).lstrip("\n")
    return Scroll(sid, cat, lu, ver, ids, sup, body)


def render(s: Scroll) -> str:
    q = lambda x: json.dumps(x, ensure_ascii=False)  # noqa: E731
    fm = [
        "---",
        f"scroll_id: {q(s.scroll_id)}",
        f"category: {q(s.category)}",
        f"last_updated: {q(s.last_updated)}",
        f"version: {int(s.version)}",
        f"source_archive_ids: [{', '.join(q(x) for x in s.source_archive_ids)}]",
        f"supersedes: [{', '.join(q(x) for x in s.supersedes)}]",
        "---",
    ]
    return "\n".join(fm) + "\n" + s.body.strip("\n") + "\n"


def size_of(s: Scroll) -> int:
    return len(render(s).encode("utf-8"))


def check_matches(t: Target, s: Scroll) -> None:
    if s.scroll_id != t.scroll_id or s.category != t.category:
        raise ScrollError("frontmatter scroll_id/category do not match the path")


def read_scroll(root: Path, rel: str) -> Optional[Scroll]:
    """The scroll at `rel` (None when absent). Invalid files raise ScrollError."""
    p = resolve_in_root(root, rel)
    if not p.is_file():
        return None
    s = parse(p.read_text(encoding="utf-8"))
    check_matches(target_info(rel), s)
    return s


def list_scrolls(root: Path) -> List[Tuple[str, Optional[Scroll], int]]:
    """(rel, scroll or None when invalid, bytes) for every canonical file under `root`."""
    out = []
    root = Path(root)
    for sub in ("core", "projects", "patterns"):
        d = root / sub
        if not d.is_dir() or fsutil.is_reparse(d):
            continue
        for p in sorted(d.glob("*.md")):
            rel = f"{sub}/{p.name}"
            if not REL_RE.match(rel) or fsutil.is_reparse(p):
                continue
            try:
                s = read_scroll(root, rel)
            except (ScrollError, OSError, UnicodeDecodeError):
                s = None
            out.append((rel, s, p.stat().st_size))
    return out


# ── body structure ──────────────────────────────────────────────────────────


def norm(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"^[\-\*\+]\s+", "", s)
    s = s.replace("`", "").replace("**", "")
    s = re.sub(r"\s+", " ", s)
    return s.strip(" .;,")


def _outline(body: str) -> List[Tuple[Optional[str], int, str]]:
    """(current H2 name or None, level of this line if heading else 0, line), fence-aware."""
    out = []
    cur: Optional[str] = None
    fence = False
    for line in body.replace("\r\n", "\n").split("\n"):
        if line.lstrip().startswith("```"):
            fence = not fence
            out.append((cur, 0, line))
            continue
        if not fence:
            m = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", line)
            if m:
                level = len(m.group(1))
                if level == 2:
                    cur = m.group(2).strip()
                out.append((cur, level, line))
                continue
        out.append((cur, 0, line))
    return out


def h2_list(body: str) -> List[str]:
    return [line.split(None, 1)[1].strip() for _, lvl, line in _outline(body) if lvl == 2]


def has_title(body: str) -> bool:
    for _, lvl, _line in _outline(body):
        if lvl == 1:
            return True
        if lvl == 2:
            return False
    return False


def section_bullets(body: str, names: Sequence[str]) -> List[str]:
    return [line for sec, lvl, line in _outline(body) if lvl == 0 and sec in names and re.match(r"^\s*[\-\*\+]\s+\S", line)]


def lines_outside(body: str, name: str) -> List[str]:
    return [line for sec, lvl, line in _outline(body) if lvl == 0 and sec != name and line.strip()]


def _longest_fence(body: str) -> int:
    longest, cur, inside = 0, 0, False
    for line in body.split("\n"):
        if line.lstrip().startswith("```"):
            if inside:
                longest = max(longest, cur)
            inside, cur = not inside, 0
            continue
        if inside:
            cur += 1
    if inside:
        longest = max(longest, cur)
    return longest


def strip_body_frontmatter(t: Target, body: str) -> Tuple[str, Optional[str]]:
    """Remove frontmatter the model echoed into the body; a disagreeing one is an error."""
    b = body.lstrip("﻿").replace("\r\n", "\n")
    if not b.lstrip().startswith("---"):
        return b, None
    b = b.lstrip()
    try:
        s = parse(b)
    except ScrollError:
        lines = b.split("\n")
        end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
        if end is None:
            return b, "frontmatter in body is unterminated"
        fm_text = "\n".join(lines[1:end])
        sid = re.search(r'scroll_id:\s*"?([^"\s#]+)', fm_text)
        cat = re.search(r'category:\s*"?([^"\s#]+)', fm_text)
        if (sid and sid.group(1) != t.scroll_id) or (cat and cat.group(1) != t.category):
            return b, "frontmatter in body disagrees with the target"
        return "\n".join(lines[end + 1:]).lstrip("\n"), None
    if s.scroll_id != t.scroll_id or s.category != t.category:
        return b, "frontmatter in body disagrees with the target"
    return s.body, None


# ── validation and merge ────────────────────────────────────────────────────


def one_line(s: str, n: int = 300) -> str:
    s = re.sub(r"\s+", " ", str(s)).strip()
    # ASCII "..." (not U+2026): warnings and NDJSON are read through consoles that are not UTF-8.
    return s if len(s) <= n else s[: max(1, n - 3)] + "..."


def shape_errors(reply) -> List[str]:
    if not isinstance(reply, dict):
        return ["reply is not a JSON object"]
    errs = []
    if set(reply.keys()) != REPLY_KEYS:
        missing = sorted(REPLY_KEYS - set(reply.keys()))
        extra = sorted(str(k)[:30] for k in set(reply.keys()) - REPLY_KEYS)[:4]
        detail = "; ".join(x for x in (f"missing {', '.join(missing)}" if missing else "", f"unexpected {', '.join(extra)}" if extra else "") if x)
        errs.append(f"reply keys must be exactly {sorted(REPLY_KEYS)} ({detail})")
        return errs
    if not isinstance(reply["target_scroll"], str):
        errs.append("target_scroll must be a string")
    if not isinstance(reply["updated_markdown"], str) or not reply["updated_markdown"].strip():
        errs.append("updated_markdown must be a non-empty string")
    ents = reply["graph_entities_to_upsert"]
    if not isinstance(ents, list):
        errs.append("graph_entities_to_upsert must be a list")
    else:
        if len(ents) > 12:
            errs.append("more than 12 graph entities")
        # Every entity error is listed (not just the first) so a report shows the whole picture.
        for i, e in enumerate(ents, 1):
            if not isinstance(e, dict) or set(e.keys()) != {"name", "entityType", "observations"}:
                errs.append(f"entity {i}: entity must have exactly name, entityType, observations")
                continue
            if not isinstance(e["name"], str) or not 1 <= len(e["name"].strip()) <= 80:
                errs.append(f"entity {i}: entity name must be 1..80 chars")
                continue
            label = f"entity {i} ({one_line(e['name'], 40)})"
            if e["entityType"] not in ENTITY_TYPES:
                errs.append(f"{label}: bad entityType {str(e['entityType'])[:40]}")
            obs = e["observations"]
            if not isinstance(obs, list) or len(obs) > 8 or not all(isinstance(o, str) and len(o) <= 200 for o in obs):
                errs.append(f"{label}: observations must be <= 8 strings of <= 200 chars")
    facts = reply["superseded_facts"]
    if not isinstance(facts, list):
        errs.append("superseded_facts must be a list")
    else:
        if len(facts) > 10:
            errs.append("more than 10 superseded facts")
        for i, f in enumerate(facts, 1):
            if not isinstance(f, dict) or not {"old", "new"} <= set(f.keys()) or not set(f.keys()) <= {"old", "new", "reason"}:
                errs.append(f"fact {i}: superseded fact must have old, new (and optional reason)")
                continue
            if not isinstance(f["old"], str) or not isinstance(f["new"], str) or len(f["old"]) > 300 or len(f["new"]) > 300:
                errs.append(f"fact {i}: superseded old/new must be strings <= 300 chars")
            if not isinstance(f.get("reason", ""), str) or len(f.get("reason", "")) > 160:
                errs.append(f"fact {i}: superseded reason must be a string <= 160 chars")
    return errs


def body_errors(t: Target, old: Optional[Scroll], body: str, facts: Sequence[dict], entities: Sequence[dict], known: Iterable[str], sub_scrolls: bool = False) -> List[str]:
    known = list(known)
    errs = []
    if not has_title(body):
        errs.append("missing # title")
    hs = h2_list(body)
    pos = -1
    for h in headings_for(t, sub_scrolls):
        if h not in hs:
            errs.append(f"missing heading ## {h}")
            continue
        i = hs.index(h)
        if i < pos:
            errs.append(f"heading ## {h} out of order")
        pos = max(pos, i)
    if hs and hs[-1] != SUPERSEDED:
        errs.append("## Superseded Decisions must be the last section")
    outside = [norm(x) for x in lines_outside(body, SUPERSEDED)]
    # A fact a later one reverted names a value that is current again: neither "still stated"
    # nor an excuse for a dropped locked bullet.
    live = unreverted_facts(facts)
    for f in live:
        no = norm(f.get("old", ""))
        if len(no) < 4:
            continue
        if any(no == x or (len(no) >= 12 and no in x) for x in outside):
            errs.append("a superseded fact is still stated outside ## Superseded Decisions")
            break
    if old is not None:
        new_lines = [norm(x) for x in body.split("\n") if x.strip()]
        # Only a real value change accounts for a dropped locked bullet: its `new` is a value (not
        # empty, not "removed" / "compressed") that the body states. Otherwise a reply could drop a
        # locked decision into the 8-line Superseded log by "superseding" it with nothing.
        sup_old = [norm(f.get("old", "")) for f in live if states_new_value(f, outside)]
        for b in section_bullets(old.body, LOCKED_HEADINGS):
            nb = norm(b)
            if not nb or nb in ("(none yet)", "none"):
                continue
            kept = any(nb == x or nb in x for x in new_lines)
            # A superseded fact only accounts for this bullet when it names it: the whole bullet,
            # or a specific (>= 12 chars) part of it. A short / generic `old` ("on") never does.
            replaced = any(len(s) >= 4 and (s == nb or nb in s or (len(s) >= 12 and s in nb)) for s in sup_old)
            if not kept and not replaced:
                errs.append("a locked decision was dropped without a superseded_facts entry")
                break
    if malformed_superseded(body, old.body if old is not None else ""):
        errs.append("malformed ## Superseded Decisions line (a list marker inside the old / new value)")
    texts = [body] + [str(e.get("name", "")) for e in entities] + [o for e in entities for o in e.get("observations", [])]
    texts += [str(f.get(k, "")) for f in facts for k in ("old", "new", "reason")]
    if any(scrub(x, known) != x for x in texts):
        errs.append("secret-like content in the reply")
    if _BAD_TAG.search(body) or "<think" in body.lower():
        errs.append("HTML / think / script tags in the body")
    if _longest_fence(body) > 12:
        errs.append("code fence longer than 12 lines")
    return errs


_BULLET = re.compile(r"^\s*[\-\*\+]\s+\S")
# A superseded `new` that only says the line went away ("removed", "compressed for brevity",
# "n/a"): no digits / paths, so a real value ("none on port 1235") never matches.
_REMOVAL_ONLY = re.compile(
    r"^\(?(?:removed|deleted|dropped|omitted|compressed|condensed|trimmed|cut|summari[sz]ed|shortened|n/?a|none|null|nil|nothing|"
    r"empty|gone|obsolete|redundant|duplicate|not needed|no longer (?:needed|relevant|applies)|for brevity)\b[^0-9:\\/]{0,60}$",
    re.I,
)


def states_new_value(f: dict, outside_norm: Sequence[str]) -> bool:
    """True when superseded fact `f` names a real new value (>= 3 chars, not a removal) that one
    of `outside_norm` (normalised body lines outside ## Superseded Decisions) states."""
    nn = norm(str(f.get("new", "")) if isinstance(f, dict) else "")
    if len(nn) < 3 or _REMOVAL_ONLY.match(nn):
        return False
    return any(nn == x or nn in x for x in outside_norm)


def _fact_olds(facts: Sequence[dict]) -> List[str]:
    """norm(old) of every usable fact (>= 4 chars, and not a no-op where old == new)."""
    out = []
    for f in facts or []:
        if not isinstance(f, dict) or not isinstance(f.get("old"), str):
            continue
        no = norm(f["old"])
        if len(no) >= 4 and no != norm(str(f.get("new", ""))):
            out.append(no)
    return out


def unreverted_facts(facts: Sequence[dict]) -> List[dict]:
    """`facts` (oldest first) without the ones a later fact reverted (a later `new` == this `old`):
    the reverted value is current again, so it may (and should) be stated in the body."""
    facts = [f for f in facts or [] if isinstance(f, dict)]
    out = []
    for i, f in enumerate(facts):
        no = norm(str(f.get("old", "")))
        if no and any(norm(str(g.get("new", ""))) == no for g in facts[i + 1:]):
            continue
        out.append(f)
    return out


def drop_stated_superseded(body: str, facts: Sequence[dict]) -> Tuple[str, List[str]]:
    """Remove body lines outside ## Superseded Decisions that state a superseded fact's `old`
    EXACTLY (after `norm`). The model often lists a fact as superseded and forgets to delete it;
    `enforce_superseded` still logs the fact. A line that merely contains `old` is left alone, so
    `body_errors` still rejects that (ambiguous) case.

    Only a fact whose `new` is itself stated in the body (on a line other than `old`) removes
    anything: a move / reword recorded as a supersede ("-> moved to Guardrails") or a fact the
    body never applied would otherwise turn a still-current (locked) line into a log entry.
    Facts reverted by a later fact (`unreverted_facts`) never remove anything."""
    outside = [norm(x) for x in lines_outside(body, SUPERSEDED)]
    olds = set()
    for f in unreverted_facts(facts):
        no = _fact_olds([f])
        if not no:
            continue
        nn = norm(str(f.get("new", "")))
        if len(nn) >= 4 and any(x != no[0] and (nn == x or nn in x) for x in outside):
            olds.add(no[0])
    if not olds:
        return body, []
    out, removed = [], []
    for sec, lvl, line in _outline(body):
        if lvl == 0 and sec != SUPERSEDED and line.strip() and norm(line) in olds:
            removed.append(line.strip())
            continue
        out.append(line)
    return "\n".join(out), removed


def prune_superseded_log(body: str, facts: Sequence[dict], keep_body: str) -> Tuple[str, List[str]]:
    """Keep ## Superseded Decisions to real supersede lines: a bullet survives when it was already
    in `keep_body` (the current scroll) or is an `old -> new` line for one of `facts`. Changelog
    prose, echoed templates and paraphrased duplicates are dropped; `enforce_superseded` then adds
    exactly one line per fact."""
    keep = {norm(x) for x in (keep_body or "").split("\n") if x.strip()}
    olds = _fact_olds(facts)
    out, removed = [], []
    for sec, lvl, line in _outline(body):
        if lvl == 0 and sec == SUPERSEDED and _BULLET.match(line):
            nb = norm(line)
            text = re.sub(r"^\s*[\-\*\+]\s+", "", line).strip()
            fact_line = " -> " in text and not text.startswith("`") and any(o in nb for o in olds)
            if nb not in keep and not fact_line:
                removed.append(line.strip())
                continue
        out.append(line)
    return "\n".join(out), removed


_LIST_MARK = re.compile(r"^\s*(?:[\-\*\+]\s+)+")


def _superseded_line(today: str, f: dict, archive_id: str) -> str:
    # A value never carries its own list marker: "- DATE: - old -> - new" is malformed.
    old = _LIST_MARK.sub("", one_line(f.get("old", "")))
    new = _LIST_MARK.sub("", one_line(f.get("new", "")))
    return f"- {today}: {old} -> {new} ({archive_id})"


# A ## Superseded Decisions line whose old or new value carries its own list marker
# ("- 2026-11-19: - User: x -> - User: y (arch-pending)"): malformed.
_DOUBLE_MARK = re.compile(r"^[\-\*\+]\s+\d{4}-\d{2}-\d{2}:\s+[\-\*\+]\s|\s->\s+[\-\*\+]\s")


def malformed_superseded(body: str, keep_body: str = "") -> List[str]:
    """NEW ## Superseded Decisions lines (not in `keep_body`) with a list marker inside a value."""
    keep = {norm(x) for x in (keep_body or "").split("\n") if x.strip()}
    return [line.strip() for sec, lvl, line in _outline(body)
            if lvl == 0 and sec == SUPERSEDED and _BULLET.match(line) and _DOUBLE_MARK.search(line.strip()) and norm(line) not in keep]


def keep_log_lines(body: str, lines: Sequence[str], archive_id: str, today: str) -> Tuple[str, int]:
    """(body with every `lines` entry present under ## Superseded Decisions, lines re-added): host
    log lines (a removal the host made, e.g. a stale claim) never leave silently because a reply
    left them out. Ordered and capped like `enforce_superseded`."""
    have = {norm(x) for x in section_bullets(body, [SUPERSEDED])}
    missing = [x.strip() for x in lines if x.strip() and norm(x) not in have]
    if not missing:
        return body, 0
    return enforce_superseded(body.rstrip() + "\n" + "\n".join(missing) + "\n", [], archive_id, today), len(missing)


def drop_malformed_superseded(body: str, keep_body: str = "") -> Tuple[str, List[str]]:
    """(body without the NEW malformed ## Superseded Decisions lines, removed): `enforce_superseded`
    then writes one clean line per superseded fact."""
    bad = set(malformed_superseded(body, keep_body))
    if not bad:
        return body, []
    out, removed = [], []
    for sec, lvl, line in _outline(body):
        if lvl == 0 and sec == SUPERSEDED and line.strip() in bad:
            removed.append(line.strip())
            continue
        out.append(line)
    return "\n".join(out), removed


def enforce_superseded(body: str, facts: Sequence[dict], archive_id: str, today: str) -> str:
    """Make sure every superseded fact has its log line; keep the newest 8 lines."""
    rows = _outline(body)
    before: List[str] = []
    bullets: List[str] = []
    others: List[str] = []
    seen_section = False
    for sec, lvl, line in rows:
        if lvl == 2 and sec == SUPERSEDED:
            seen_section = True
            continue
        if seen_section and sec == SUPERSEDED and lvl == 0:
            if re.match(r"^\s*[\-\*\+]\s+\S", line):
                bullets.append(line.strip())
            elif line.strip():
                others.append(line.strip())
            continue
        before.append(line)
    for f in facts:
        no = norm(f.get("old", ""))
        # Already logged when `old` is on the OLD side of a line: a revert (b -> a after a -> b)
        # still gets its own line.
        if no and any(no in norm(b).split(" -> ")[0] for b in bullets):
            continue
        bullets.append(_superseded_line(today, f, archive_id))
    dated = []
    for i, b in enumerate(bullets):
        m = re.match(r"^[\-\*\+]\s+(\d{4}-\d{2}-\d{2})", b)
        dated.append((m.group(1) if m else "0000-00-00", i, b))
    dated.sort()
    bullets = [b for _, _, b in dated][-MAX_SUPERSEDED_LINES:]
    head = "\n".join(before).rstrip()
    tail = "\n".join(bullets)
    return f"{head}\n\n## {SUPERSEDED}\n\n{tail}".rstrip() + "\n"


def merge(t: Target, old: Optional[Scroll], body: str, facts: Sequence[dict], archive_id: str, now: str, legacy_supersedes: Sequence[str] = ()) -> Tuple[Scroll, bool]:
    """(scroll, changed). Idempotent: an archive id already merged returns the old scroll unchanged."""
    if old is not None and archive_id in old.source_archive_ids:
        return old, False
    today = now[:10]
    body = enforce_superseded(body, facts, archive_id, today)
    ids = [x for x in (old.source_archive_ids if old else []) if x != archive_id] + [archive_id]
    sup = list(old.supersedes if old else [])
    for x in legacy_supersedes:
        x = str(x)[:80]
        if x and x not in sup:
            sup.append(x)
    return Scroll(
        scroll_id=t.scroll_id,
        category=t.category,
        last_updated=now,
        version=(old.version + 1) if old else 1,
        source_archive_ids=ids[-MAX_IDS_INLINE:],
        supersedes=sup[-MAX_SUPERSEDES:],
        body=body,
    ), True


def validate(t: Target, old: Optional[Scroll], reply, allowed: Sequence[str], archive_id: str, now: str, known: Iterable[str] = (), legacy_supersedes: Sequence[str] = ()) -> Tuple[List[str], Optional[Scroll], List[str]]:
    """(reasons, merged scroll when valid, warnings). Reasons empty = accepted."""
    known = list(known)
    errs = shape_errors(reply)
    if errs:
        return errs, None, []
    target = reply["target_scroll"].strip()
    if target not in allowed or target != t.rel:
        return [f"target_scroll {target[:80]!r} is not an allowed target"], None, []
    try:
        target_info(target)
    except ScrollError as e:
        return [str(e)], None, []
    body, fm_err = strip_body_frontmatter(t, reply["updated_markdown"])
    if fm_err:
        return [fm_err], None, []
    sub = SUB_SCROLLS in h2_list(old.body) if old else False
    errs = body_errors(t, old, body, reply["superseded_facts"], reply["graph_entities_to_upsert"], known, sub_scrolls=sub)
    if errs:
        return errs, None, []
    merged, _ = merge(t, old, body, reply["superseded_facts"], archive_id, now, legacy_supersedes)
    size = size_of(merged)
    if size > HARD_CAP_BYTES:
        return [f"{TOO_LARGE}: {size} bytes > {HARD_CAP_BYTES}"], None, []
    warnings = [f"{t.scroll_id} is {size} bytes (target {TARGET_BYTES})"] if size > TARGET_BYTES else []
    return [], merged, warnings


def now_iso(now: Optional[_dt.datetime] = None) -> str:
    return (now or _dt.datetime.now()).astimezone().isoformat(timespec="seconds")
