"""Deterministic content guards around the distiller: schema echoes, identity, stale claims, dedupe.

Pure (no I/O). Every guard counts what it removes (rule ids / kinds, never values).

- Schema echo: the dispatcher / planner envelope (role, intent, summary, mutating, target, payload,
  missing, readBack, routeKind, the TaskEnvelope JSON keys) is an output FORMAT, never a project
  fact. Chat-like sources lose envelope JSON objects and field lines before distillation; scroll
  bullets and KG observations that echo it are dropped after.
- Identity: the agent / persona names of the Command Center roster (mirrored from
  `command center/src/features/dispatcher/roles.ts`, `router.ts` and `agents.ts`; a test fails when
  those change) are never the user. A KG person entity is the operator or nothing: an agent persona
  typed person and any other person (a private third party) are dropped; a bullet or superseded fact
  that relabels the user as an agent is dropped.
- Stale claims: `stale_claims.Policy` applied to source lines, the current scroll, reply bullets,
  facts and KG observations.
- Near-duplicate KG entities of one run are merged.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from . import privacy
from . import scroll as sc
from . import stale_claims as stc

# v2: narrower user-relabel (generic role words, "Agent: user approves ..."), near-duplicate KG merge
# only for qualifier / one-word-swap names, a demoted "(unconfirmed)" bullet is never re-locked, and
# the never-lock gate's status / unmarked / schema-field fixes (distill.one_off_kind).
# v3: plan lines (ROADMAP and other plan / goal files) only as "Planned:" Open Threads, never stated
# as done (a dated status line wins); agent imperatives (delete / download / export / send / change
# config / external services) only as "(needs Nic's approval)" Open Threads, never in Lessons or a
# locked section; Superseded hygiene (no model-written entry in a brand-new scroll, no no-op entry);
# no transient status (online / offline, timestamps); Key Paths hold paths, a "Models" label a model store.
# v4: a rule gate in a stripped label covers its list and "nothing / none / no-one" are rule gates; a
# verb with no object inside a noun list ("chat, email and calendar") is a noun, not an order;
# Superseded no-op only for a bare "Same / unchanged" (+ one note), never "Same port, HTTPS only";
# "offline-first / offline-only / offline mode" and bracketed design notes are not transient status;
# to-do sections of a status file (STATUS "Next steps") are plan lines, never the status that wins.
# v5 (fidelity): an install / config rule names Nic as the approver ("without Librarian approval" ->
# "without Nic's approval (proposed through the Librarian)", else demoted); the settled hard rules of the
# hub AGENTS_NEVER.md are host-owned standalone ## Guardrails bullets; an instruction to edit / fix / lock /
# rewrite a rule, identity, prompt or config file is an agent imperative ("(needs Nic's approval)", never
# locked); a safety-critical term carries its limits (QUALIFIERS) or the bullet goes; a NEW prohibition /
# obligation needs a source line with the same modal ("(unverified)" or dropped otherwise); a storage path
# that does not exist is "(planned, not created yet)"; contested KG observations and their companions are
# "(unconfirmed)" and conflicting entities of two targets are kept apart; near-duplicate bullets, stale
# counts ("same 7" over 4 items) and one-night measurements go.
# v6 (review of 20261120-011216): passive / modal orders ("must be repointed manually") are agent
# imperatives; a Planned: line about curating / pruning / deleting files or testing all MCPs needs Nic's
# approval; a NEW bullet restating a settled AGENTS_NEVER guardrail goes (always when it adds an exception
# such as "without explicit approval"); a model bullet with a contested #4 sentence is "(unconfirmed)"; the
# Tier-3 gate carries the auto_dispatch exception; KG: the planned marker is only ever an observation
# prefix, the name probe needs a path-like name, a bare "path" name is a "concept", and an observation that
# attributes something "for <another tool>" goes unless a source line ties both.
GUARDS_VERSION = 6

# ── roster (mirror of the Command Center; tests/test_memory_scrolls_guards.py checks it) ─────────

# roles.ts ROLE_IDS
ROLE_IDS = ("general", "booking", "prompter", "coder", "designer", "librarian", "ops")
# router.ts SELF_ROLE_IDS: every id that means Tony himself
SELF_ROLE_IDS = ("general", "tony", "os", "dispatcher", "orchestrator", "jarvis")
# agents.ts labels (+ Tony, the default OS name roles.ts shows for `general`)
ROLE_LABELS = ("Tony", "Prompter", "Designer", "Librarian", "Coder", "Booking Desk", "Ops")
# agents.ts: prep-only registry ids that already resolve (Phase 2 section 4)
PLACEHOLDER_AGENTS = ("Security Patrol", "Finance")
# ai-hub roster names that alias Command Center agents (AI_HUB_BASELINE_REPORT conflict 1)
HUB_AGENT_ALIASES = ("Conceptualizer", "Dispatcher", "Reviewer")
# Persona names (not functional roles): never in a NEW locked bullet (baseline conflict 2).
PERSONA_NAMES = ("tony", "jarvis")


def agent_names() -> frozenset:
    """Lower-case names that denote an agent, never the user."""
    words = {x.lower() for x in ROLE_LABELS + PLACEHOLDER_AGENTS + HUB_AGENT_ALIASES}
    words |= {x for x in SELF_ROLE_IDS if x not in ("general", "os")}
    words |= {x for x in ROLE_IDS if x not in ("general",)}
    return frozenset(words)


AGENT_NAMES = agent_names()
# Agent names that are also ordinary nouns (a job, a desk, a department): "the user is a designer",
# "User: designer and illustrator" describe the user, not a relabel.
GENERIC_AGENT_WORDS = frozenset({"designer", "coder", "ops", "booking", "librarian", "prompter", "dispatcher", "orchestrator", "reviewer", "finance"})


def _alt(names) -> str:
    return "|".join(sorted((re.escape(n) for n in names), key=len, reverse=True))


_NAMES_ALT = _alt(AGENT_NAMES)
_DISTINCT_ALT = _alt(AGENT_NAMES - GENERIC_AGENT_WORDS)
_GENERIC_ALT = _alt(AGENT_NAMES & GENERIC_AGENT_WORDS)
PERSONA_RX = re.compile(r"\b(?:" + "|".join(PERSONA_NAMES) + r")\b", re.I)
_USER_WORD = r"(?:the\s+)?(?:user|operator|owner|human)"
_IS = r"\s*(?:[:=(]|\bis\b|\bnamed\b|\bcalled\b|\baka\b)\s*"
# The clause ends right after the name / the user word: "User: Tony (Developer)", "Tony is the user."
_END = r"(?=\s*(?:$|[).,;:!?(]|\b(?:agent|persona|role|bot)\b))"
_USER_END = r"(?=\s*(?:$|[).,;!?]))"
USER_RELABEL = re.compile(
    # the user named as an agent: any article before a persona name, only "the" (never "a / an")
    # before a generic role word, which must also end the clause
    r"\b" + _USER_WORD + r"(?![\w'’-])" + _IS + r"(?:the\s+|an?\s+)?(?:" + _DISTINCT_ALT + r")\b"
    r"|\b" + _USER_WORD + r"(?![\w'’-])" + _IS + r"(?:the\s+)?(?:" + _GENERIC_ALT + r")\b" + _END +
    # an agent named as the user: the user word ends the clause ("Tony is the user", "Tony (the
    # user)", "Tony is the user of Agentic OS"); "Librarian: user approves ..." is a rule, not a relabel
    r"|\b(?:" + _NAMES_ALT + r")\b\s*(?:\(|[:=]|\bis\b|\bas\b)\s*(?:the\s+)?(?:user(?![\w'’-])(?=\s*(?:$|[).,;!?]|of\b))|(?:operator|owner)(?![\w'’-])" + _USER_END + r")",
    re.I | re.M,
)

CHAT_KINDS = frozenset({"turn", "gateway_chat", "rag_chat", "training_log"})

# ── schema echo ─────────────────────────────────────────────────────────────

# plan.ts ActionPlan fields the model is asked to emit, and their label form.
ENVELOPE_KEYS = ("role", "intent", "summary", "mutating", "target", "payload", "missing", "readback", "routekind", "utterance", "workflow")
# Keys that are never anything but an envelope field.
STRONG_KEYS = frozenset({"mutating", "payload", "missing", "readback", "routekind", "utterance"})
# TaskEnvelope (pipeline-store.ts / platform.ts) keys: JSON form only.
TASK_ENVELOPE_KEYS = ("task_id", "current_owner", "iteration_count", "max_iterations", "project_slug", "handoff_log", "voice_summaries", "short_summary", "voice_summary", "card_id", "idea_id")
_JSON_KEYS = ENVELOPE_KEYS + ("readBack", "routeKind", "kind") + TASK_ENVELOPE_KEYS
_JSON_KEY = re.compile(r'"(' + "|".join(_JSON_KEYS) + r')"\s*:', re.I)
_LABEL = re.compile(r"^\W*(?:\*\*)?\s*(" + "|".join(ENVELOPE_KEYS) + r")\s*(?:\*\*)?\s*[:=]", re.I)
_BULLET_LABEL = re.compile(r"^\s*[\-\*\+]\s+(?:\*\*)?\s*(" + "|".join(ENVELOPE_KEYS) + r")\s*(?:\*\*)?\s*[:=]", re.I)
_BRACES = re.compile(r"^\s*[\[\]{}(),]+\s*$")


def _json_spans(text: str) -> List[Tuple[int, int]]:
    """(start, end) of every top-level {...} in `text` (string-aware)."""
    spans, depth, start, in_str, esc = [], 0, None, False, False
    for i, c in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"' and depth:
            in_str = True
        elif c == "{":
            if depth == 0:
                start = i
            depth += 1
        elif c == "}" and depth:
            depth -= 1
            if depth == 0 and start is not None:
                spans.append((start, i + 1))
    return spans


def _envelope_object(s: str) -> bool:
    try:
        v = json.loads(s)
    except ValueError:
        v = None
    if isinstance(v, dict):
        keys = {str(k).lower() for k in v}
        return len(keys & {k.lower() for k in _JSON_KEYS}) >= 2
    return len({m.group(1).lower() for m in _JSON_KEY.finditer(s)}) >= 2


def strip_schema_text(text: str) -> Tuple[str, int]:
    """(chat text without dispatcher / planner envelopes, items removed): envelope JSON objects
    (one item each, inline or multi-line), JSON field lines naming an envelope key, bare brace lines
    left behind, and label lines ("Mutating: true", or 2+ distinct envelope labels in one record)."""
    if not text:
        return text, 0
    out = text
    n = 0
    for s, e in reversed(_json_spans(text)):
        if _envelope_object(text[s:e]):
            out = out[:s] + "\n" + out[e:]
            n += 1
    lines = out.split("\n")
    labels = {m.group(1).lower() for m in (_LABEL.match(x) for x in lines) if m}
    shape = len(labels) >= 2
    kept = []
    for x in lines:
        m = _LABEL.match(x)
        if _JSON_KEY.search(x) or (m and (shape or m.group(1).lower() in STRONG_KEYS)) or _BRACES.match(x):
            n += 1
            continue
        kept.append(x)
    return re.sub(r"\n\s*\n+", "\n", "\n".join(kept)).strip(), n


def _schema_line(line: str, shape: bool) -> bool:
    m = _BULLET_LABEL.match(line)
    if m and (shape or m.group(1).lower() in STRONG_KEYS):
        return True
    t = re.sub(r"^\s*[\-\*\+]\s+", "", line).strip()
    return bool(_JSON_KEY.search(t)) or (t.startswith("{") and t.rstrip(",").endswith("}"))


def strip_schema_body(body: str, keep_body: str = "") -> Tuple[str, int]:
    """(body without bullets that echo the envelope schema, removed). A line of `keep_body` (the
    current scroll) is never removed here; ## Superseded Decisions is left alone."""
    keep = {sc.norm(x) for x in (keep_body or "").split("\n") if x.strip()}
    rows = sc._outline(body)
    labels = {m.group(1).lower() for m in (_BULLET_LABEL.match(r[2]) for r in rows if r[1] == 0 and r[0] != sc.SUPERSEDED) if m}
    shape = len(labels) >= 2
    out, n = [], 0
    for sec, lvl, line in rows:
        if lvl == 0 and sec != sc.SUPERSEDED and line.strip() and sc.norm(line) not in keep and _schema_line(line, shape):
            n += 1
            continue
        out.append(line)
    return "\n".join(out), n


def strip_schema_observations(entities: Sequence[dict]) -> Tuple[List[dict], int]:
    out, n = [], 0
    for e in entities or []:
        obs = e.get("observations") if isinstance(e, dict) else None
        if not isinstance(obs, list):
            out.append(e)
            continue
        labels = {m.group(1).lower() for m in (_LABEL.match(o) for o in obs if isinstance(o, str)) if m}
        shape = len(labels) >= 2
        kept = [o for o in obs if not (isinstance(o, str) and (_JSON_KEY.search(o) or ((lambda m: m and (shape or m.group(1).lower() in STRONG_KEYS))(_LABEL.match(o)))))]
        n += len(obs) - len(kept)
        if kept or not obs:
            out.append({**e, "observations": kept} if len(kept) != len(obs) else e)
    return out, n


# ── identity ────────────────────────────────────────────────────────────────


def _norm_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip()


def is_operator(name: str) -> bool:
    return (_norm_name(name).split() or [""])[0] in privacy._USER_NAMES


def is_agent_name(name: str) -> bool:
    n = _norm_name(name)
    if n in AGENT_NAMES:
        return True
    toks = n.split()
    return bool(toks) and toks[0] in AGENT_NAMES and (len(toks) == 1 or toks[1] in ("agent", "persona", "bot", "assistant"))


def relabels_user(text: str) -> bool:
    return bool(USER_RELABEL.search(text or ""))


def identity_body(body: str, keep_body: str = "") -> Tuple[str, int]:
    """(body without NEW lines that relabel the user as an agent persona, removed)."""
    keep = {sc.norm(x) for x in (keep_body or "").split("\n") if x.strip()}
    out, n = [], 0
    for sec, lvl, line in sc._outline(body):
        if lvl == 0 and line.strip() and sc.norm(line) not in keep and relabels_user(line):
            n += 1
            continue
        out.append(line)
    return "\n".join(out), n


def identity_facts(facts: Sequence[dict]) -> Tuple[List[dict], int]:
    """Superseded facts that relabel the user (old or new names the user as an agent) are dropped."""
    out, n = [], 0
    for f in facts or []:
        if isinstance(f, dict) and any(relabels_user(str(f.get(k) or "")) for k in ("old", "new")):
            n += 1
            continue
        out.append(f)
    return out, n


def identity_entities(entities: Sequence[dict]) -> Tuple[List[dict], Counter]:
    """A person entity is the operator or nothing: an agent persona typed person is dropped
    ("persona_person"), any other person too ("third_party_person"). Observations that relabel
    the user as an agent are dropped from every kept entity ("user_relabel")."""
    counts: Counter = Counter()
    out: List[dict] = []
    for e in entities or []:
        if not isinstance(e, dict):
            out.append(e)
            continue
        name = str(e.get("name") or "")
        if e.get("entityType") == "person" and not is_operator(name):
            counts["persona_person" if is_agent_name(name) else "third_party_person"] += 1
            continue
        obs = e.get("observations")
        if isinstance(obs, list):
            kept = [o for o in obs if not (isinstance(o, str) and relabels_user(o))]
            if len(kept) != len(obs):
                counts["user_relabel"] += len(obs) - len(kept)
                if not kept:
                    continue
                e = {**e, "observations": kept}
        out.append(e)
    return out, counts


_GENERIC = frozenset("app apps tool tools service services project projects system systems agent agents the a an of for and".split())
# Words that qualify a name without naming another thing ("LM Studio server").
_QUALIFIERS = frozenset("server application instance".split())


def _tokens(name: str) -> List[str]:
    return [w[:-1] if len(w) > 3 and w.endswith("s") else w for w in _norm_name(name).split()]


def _near_dup(a: dict, b: dict) -> bool:
    if a.get("entityType") != b.get("entityType"):
        return _norm_name(a.get("name", "")) == _norm_name(b.get("name", ""))
    ta, tb = _tokens(a.get("name", "")), _tokens(b.get("name", ""))
    if not ta or not tb:
        return False
    if ta == tb:
        return True
    # A longer name is the same entity only when its extra words are generic qualifiers ("LM Studio"
    # ~ "LM Studio server"); "Agentic OS" vs "Agentic OS Command Center", "AI Hub" vs "AI Hub Memory"
    # and "Scene Reader" vs "Scene Reader Estimator" are distinct systems / components.
    sa, sb = set(ta) - _GENERIC, set(tb) - _GENERIC
    if sa and sb and min(len(sa), len(sb)) >= 2 and (sa <= sb or sb <= sa) and (sa ^ sb) <= _QUALIFIERS:
        return True
    # Two names of one idea: same length, same first word, same generic last word, one word swapped
    # ("Recipe Scaler App" ~ "Recipe Calculator App"); "Command Center HUD" vs "Command Center Voice"
    # (no generic head) are sibling components.
    if len(ta) == len(tb) >= 3 and ta[0] == tb[0] and ta[-1] == tb[-1] and ta[-1] in _GENERIC:
        return sum(1 for x, y in zip(ta, tb) if x != y) == 1
    return False


def dedupe_entities(entities: Sequence[dict]) -> Tuple[List[dict], int]:
    """Near-duplicate entities (same type; same name, one name a subset of the other, or half the
    words shared with the same first word) are merged into the first, observations de-duplicated
    and capped at 8. Returns (entities, merged)."""
    out: List[dict] = []
    merged = 0
    for e in entities or []:
        if not isinstance(e, dict):
            out.append(e)
            continue
        hit = next((x for x in out if isinstance(x, dict) and _near_dup(x, e)), None)
        if hit is None:
            out.append({**e, "observations": list(e.get("observations") or [])})
            continue
        merged += 1
        have = {sc.norm(o) for o in hit["observations"] if isinstance(o, str)}
        for o in e.get("observations") or []:
            if isinstance(o, str) and sc.norm(o) not in have and len(hit["observations"]) < 8:
                hit["observations"].append(o)
                have.add(sc.norm(o))
    return out, merged


# ── stale claims on outputs ─────────────────────────────────────────────────

# The `new` side of the ## Superseded Decisions line logged for a stale locked bullet the host removed.
STALE_LOG_MARK = "(dropped: stale claim"
# Where a demoted (contested) bullet goes per scroll kind: a non-locked heading of that template.
UNCONFIRMED_TO = {"project": "Open Threads", "architecture": "Guardrails", "identity": "Identity"}


def _dest(t: sc.Target, heads: Iterable[str]) -> Optional[str]:
    heads = list(heads)
    want = UNCONFIRMED_TO.get(t.kind)
    if want in heads:
        return want
    return next((h for h in sc.headings_for(t) if h in heads and h not in sc.LOCKED_HEADINGS and h != sc.SUPERSEDED), None)


def _append_to(rows: List[Tuple[Optional[str], int, str]], moves: Dict[str, List[str]]) -> str:
    out: List[str] = []
    for i, (sec, lvl, line) in enumerate(rows):
        out.append(line)
        nxt = rows[i + 1] if i + 1 < len(rows) else None
        if sec in moves and (nxt is None or nxt[1] == 2):
            while out and not out[-1].strip():
                out.pop()
            if out and out[-1].lstrip().startswith("#"):
                out.append("")
            out += moves.pop(sec) + [""]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out))


# A bullet that already carries the "(unconfirmed)" prefix (a demoted, contested claim).
_UNCONFIRMED_BULLET = re.compile(r"^\s*[\-\*\+]\s+(?:\*\*)?\s*(?:\(unconfirmed\)|\(unverified\))", re.I)
_RELOCK = stc.Rule("unconfirmed-relock", r"(?!)", "demote", "a demoted (unconfirmed) bullet stays out of the locked sections", "", False, "guard")


_CONTESTED_RULE_ID = "contested-librarian-sole-writer"


def _contested_rule(policy: stc.Policy, line: str) -> Optional[stc.Rule]:
    """The policy's contested #4 rule when a sentence of `line` holds a contested Librarian claim
    (`contested_sentence`, round 10: the "only" bound to the Librarian's authority), else None (also
    when an override removed that rule)."""
    rule = next((r for r in policy.rules if r.id == _CONTESTED_RULE_ID and r.action == "demote"), None)
    if rule is None:
        return None
    _, rest = _marks(_split_bullet(line)[1])
    sents = re.split(r"[.;!?]+(?:\s+|$)", rest.replace("**", " "))
    return rule if any(s.strip() and contested_sentence(s) for s in sents) else None


def stale_body(t: sc.Target, body: str, cur_body: str = "", policy: Optional[stc.Policy] = None, existing_only: bool = False,
               archive_id: str = "", today: str = "") -> Tuple[str, Counter, Counter, List[dict]]:
    """(body, dropped {rule: n}, demoted {rule: n}, log facts) after the stale-claims policy.

    Reply mode (`existing_only=False`): lines of `cur_body` are never touched (the current scroll
    was filtered already); a NEW line matching a drop rule goes, one matching a demote rule leaves
    the locked sections (to UNCONFIRMED_TO's heading) with the "(unconfirmed)" prefix. The exemption
    is section-aware: a line of `cur_body` only stays under a locked heading when it was locked in
    `cur_body` too, so a demoted "(unconfirmed)" bullet the reply moves back into a locked section is
    demoted again (rule id "unconfirmed-relock" when no rule matches it any more).

    Current-scroll mode (`existing_only=True`): only rules with `existing: true` apply; a dropped
    LOCKED bullet is returned as a log fact {old, new, reason} so the caller logs it under
    ## Superseded Decisions. ## Superseded Decisions itself is never filtered."""
    policy = policy or stc.default_policy()
    keep = set() if existing_only else {sc.norm(x) for x in (cur_body or "").split("\n") if x.strip()}
    keep_locked = set() if existing_only else {
        sc.norm(line) for sec, lvl, line in sc._outline(cur_body or "") if lvl == 0 and sec in sc.LOCKED_HEADINGS and line.strip()}
    rows = sc._outline(body)
    heads = [r[2].split(None, 1)[1].strip() for r in rows if r[1] == 2]
    dest = _dest(t, heads)
    dropped: Counter = Counter()
    demoted: Counter = Counter()
    facts: List[dict] = []
    moves: Dict[str, List[str]] = {}
    kept_rows = []
    dest_have = {sc.norm(r[2]) for r in rows if r[0] == dest and r[1] == 0 and r[2].strip()}
    for sec, lvl, line in rows:
        in_locked = sec in sc.LOCKED_HEADINGS
        nl = sc.norm(line) if line.strip() else ""
        if lvl != 0 or not line.strip() or sec == sc.SUPERSEDED or sec is None or (nl in keep and (not in_locked or nl in keep_locked)):
            kept_rows.append((sec, lvl, line))
            continue
        rule = policy.match(line)
        if rule is None and not existing_only and sc._BULLET.match(line) and not _UNCONFIRMED_BULLET.match(line):
            # v6: a NEW model bullet with a contested #4 sentence ("...; only Librarian with Nic's
            # approval") is demoted like the policy's own matches (per sentence, so a host settled
            # bullet, built from the sentences this check passes, is never touched).
            rule = _contested_rule(policy, line)
        locked = in_locked and bool(sc._BULLET.match(line))
        if rule is None and locked and not existing_only and _UNCONFIRMED_BULLET.match(line):
            rule = _RELOCK  # a demoted bullet never goes back under a locked heading
        if rule is None or (existing_only and not rule.existing):
            kept_rows.append((sec, lvl, line))
            continue
        if rule.action == "drop":
            dropped[rule.id] += 1
            if locked and existing_only:
                text = re.sub(r"^\s*[\-\*\+]\s+", "", line).strip()
                facts.append({"old": text, "new": f"{STALE_LOG_MARK} {rule.id} {rule.ref})".replace(" )", ")"), "reason": rule.reason})
            continue
        new_line = stc.unconfirmed(line)
        if locked and dest:
            demoted[rule.id] += 1
            ind = len(new_line) - len(new_line.lstrip())
            moved = new_line[ind:].rstrip()
            if sc.norm(moved) not in dest_have:  # the reply may also list it under that heading
                moves.setdefault(dest, []).append(moved)
                dest_have.add(sc.norm(moved))
            continue
        if new_line != line:
            demoted[rule.id] += 1
        kept_rows.append((sec, lvl, new_line))
    if not dropped and not demoted:
        return body, dropped, demoted, facts
    out = _append_to(kept_rows, moves) if moves else "\n".join(x[2] for x in kept_rows)
    if facts and archive_id:
        out = sc.enforce_superseded(out, facts, archive_id, today)
    return out, dropped, demoted, facts


def stale_current(t: sc.Target, old: Optional[sc.Scroll], policy: Optional[stc.Policy], archive_id: str, today: str):
    """(current scroll after the `existing: true` rules, dropped, demoted, log facts); None-safe."""
    if old is None:
        return None, Counter(), Counter(), []
    body, dropped, demoted, facts = stale_body(t, old.body, "", policy, existing_only=True, archive_id=archive_id, today=today)
    if not dropped and not demoted:
        return old, dropped, demoted, facts
    return sc.Scroll(old.scroll_id, old.category, old.last_updated, old.version, list(old.source_archive_ids), list(old.supersedes), body), dropped, demoted, facts


def stale_entities(entities: Sequence[dict], policy: Optional[stc.Policy] = None) -> Tuple[List[dict], Counter, Counter]:
    """(entities, dropped {rule: n}, demoted {rule: n}): an entity whose NAME matches a drop rule
    goes whole; a matching observation is dropped (drop) or prefixed "(unconfirmed)" (demote); an
    entity left with no observation goes too."""
    policy = policy or stc.default_policy()
    dropped: Counter = Counter()
    demoted: Counter = Counter()
    out: List[dict] = []
    for e in entities or []:
        if not isinstance(e, dict):
            out.append(e)
            continue
        r = policy.match(str(e.get("name") or ""), "drop")
        if r is not None:
            dropped[r.id] += 1
            continue
        obs = e.get("observations")
        if not isinstance(obs, list) or not obs:
            out.append(e)
            continue
        kept = []
        name = str(e.get("name") or "")
        contested: List[str] = []
        for o in obs:
            # The entity name is the observation's subject ("Hermes Agent": "needs Python 3.11").
            r = policy.match(f"{name}: {o}") if isinstance(o, str) else None
            if r is None:
                kept.append(o)
            elif r.action == "drop":
                dropped[r.id] += 1
            else:
                # Counted only when it changes: an observation already "(unconfirmed)" is a fixed point
                # (otherwise --apply refused every preview holding a demoted contested observation).
                new_o = stc.unconfirmed(o)
                if new_o != o:
                    demoted[r.id] += 1
                kept.append(new_o)
                contested.append(r.id)
        # v5: an entity holding a contested observation states the rest of that claim in its sibling
        # observations too ("requires Nic's approval for every change", "commits one Git commit per
        # approved rule" beside "(unconfirmed) sole rule writer"): they are "(unconfirmed)" as well.
        for rid in dict.fromkeys(contested):
            comp = KG_COMPANIONS.get(rid)
            if comp is None:
                continue
            for k, o in enumerate(kept):
                if isinstance(o, str) and comp.search(o) and not _KG_READONLY.search(o):
                    new_o = stc.unconfirmed(o)
                    if new_o != o:
                        demoted[rid] += 1
                        kept[k] = new_o
        if kept:
            out.append({**e, "observations": kept} if kept != obs else e)
    return out, dropped, demoted


# v5: per contested (demote) rule, the sibling KG observations that restate the rest of its claim.
KG_COMPANIONS: Dict[str, "re.Pattern[str]"] = {
    "contested-librarian-sole-writer": re.compile(r"\b(?:approv\w*|commit\w*|writ(?:e|es|ing|er|ers)|rules?|sole|only)\b", re.I),
    "contested-escalation-ladder": re.compile(r"\b(?:escalat\w*|gemini|claude|heavy|polish)\b", re.I),
    "contested-hub-single-source": re.compile(r"\bsource\s+of\s+truth\b", re.I),
}
# Read-only / never-writes statements (never a companion of a writer claim; a conflict with one).
_KG_READONLY = re.compile(r"\bread-?only\b|\bnever\s+(?:writes?|edits?|commits?)\b|\b(?:does\s+not|doesn'?t|cannot|can'?t)\s+(?:write|edit|commit)\b|\bno\s+write\b", re.I)
_KG_WRITER = re.compile(r"\b(?:writ(?:e|es|ing)|writers?|commits?|committing|edits?|authori[sz]ed\s+to\s+(?:write|edit|change))\b", re.I)


def observations_conflict(a: Sequence[str], b: Sequence[str]) -> bool:
    """True when two entities' observations disagree: one side read-only / never writing and the other
    a writer, or a contested ("(unconfirmed)") claim on one side only."""
    def pol(obs):
        obs = [o for o in obs or [] if isinstance(o, str)]
        ro = any(_KG_READONLY.search(o) for o in obs)
        wr = any(_KG_WRITER.search(_KG_READONLY.sub(" ", o)) for o in obs if not _KG_READONLY.search(o))
        unc = any(stc.UNCONFIRMED in o.lower()[:40] for o in obs)
        return ro, wr, unc
    ra, wa, ua = pol(a)
    rb, wb, ub = pol(b)
    return (ra and wb and not wa) or (rb and wa and not wb) or ua != ub


def kg_conflicts(ents_by_rel: Dict[str, Sequence[dict]]) -> List[str]:
    """Names of near-duplicate entities of two different targets whose observations conflict (the
    dry-run keeps such entities apart under disambiguated names; `--apply` refuses a preview that
    still holds them)."""
    flat = [(rel, e) for rel, ents in sorted((ents_by_rel or {}).items()) for e in ents or [] if isinstance(e, dict)]
    out: List[str] = []
    for i, (ra, a) in enumerate(flat):
        for rb, b in flat[i + 1:]:
            if ra != rb and _near_dup(a, b) and observations_conflict(a.get("observations") or [], b.get("observations") or []):
                out.append(str(a.get("name") or ""))
    return sorted(set(out))


def kg_scope(rel: str, records: Sequence[dict]) -> str:
    """The label that keeps two conflicting entities apart: where the target's batch came from."""
    hints = {(r.get("meta") or {}).get("hint") for r in records or []}
    if hints == {"repo"}:
        return "Command Center"
    if hints == {"hub"}:
        return "ai-hub"
    return sc.target_info(rel).title


def stale_facts(facts: Sequence[dict], policy: Optional[stc.Policy] = None) -> Tuple[List[dict], Counter]:
    """A superseded fact whose NEW value is a stale claim is dropped (correcting a stale claim,
    old = stale, is kept)."""
    policy = policy or stc.default_policy()
    out, c = [], Counter()
    for f in facts or []:
        r = policy.match(str(f.get("new") or ""), "drop") if isinstance(f, dict) else None
        if r is not None:
            c[r.id] += 1
            continue
        out.append(f)
    return out, c


# ── title ───────────────────────────────────────────────────────────────────


def normalize_title(t: sc.Target, body: str) -> Tuple[str, bool]:
    """The first H1 set to `t.title` when it only differs in case / spacing / hyphens."""
    lines = body.split("\n")
    for i, x in enumerate(lines):
        m = re.match(r"^#\s+(.+?)\s*$", x)
        if m:
            if m.group(1) != t.title and _norm_name(m.group(1)) == _norm_name(t.title):
                lines[i] = f"# {t.title}"
                return "\n".join(lines), True
            return body, False
        if x.startswith("## "):
            break
    return body, False


def ensure_superseded_heading(t: sc.Target, body: str, cur_body: str = "") -> Tuple[str, bool]:
    """(body, added): a reply that left out the whole `## Superseded Decisions` heading (every other
    template heading present, in any order) gets an empty one appended, but only when the current body
    has no Superseded line to lose (a brand-new or still-empty log); otherwise the strict validator
    rejects the reply as before."""
    hs = sc.h2_list(body)
    if sc.SUPERSEDED in hs or not all(h in hs for h in sc.headings_for(t) if h != sc.SUPERSEDED):
        return body, False
    if sc.section_bullets(cur_body or "", [sc.SUPERSEDED]):
        return body, False
    return body.rstrip() + f"\n\n## {sc.SUPERSEDED}\n", True


# ── source guard (before distillation) ──────────────────────────────────────


class SourceGuard:
    """`distill.batch_text_spans(..., guard=SourceGuard(policy))`: per record body, after the
    prefilter: chat-like records lose envelope echoes; every record loses stale-claim lines."""

    def __init__(self, policy: Optional[stc.Policy] = None):
        self.policy = policy or stc.default_policy()
        self.stale: Counter = Counter()
        self.schema = 0

    def __call__(self, record: dict, body: str) -> str:
        if record.get("kind") in CHAT_KINDS:
            body, n = strip_schema_text(body)
            self.schema += n
        body, c = stc.filter_text(body, self.policy)
        self.stale.update(c)
        return body


# ── bullet marks (host prefixes) ────────────────────────────────────────────

PLANNED = "Planned:"
NEEDS_APPROVAL = "(needs Nic's approval)"
UNVERIFIED = "(unverified)"
_MARK = re.compile(r"^\s*(?:\(unconfirmed\)|\(unverified\)|\(needs nic['’]s approval\)|planned\s*:)\s*", re.I)
_BULLET_LEAD = re.compile(r"^(\s*[\-\*\+]\s+)(.*)$", re.S)
OPEN_THREADS = "Open Threads"


def _split_bullet(line: str) -> Tuple[str, str]:
    m = _BULLET_LEAD.match(line)
    return (m.group(1), m.group(2)) if m else ("", line)


def _marks(text: str) -> Tuple[set, str]:
    """({"unconfirmed", "approval", "planned"} found as leading marks, the text after them)."""
    found: set = set()
    rest = text
    while True:
        m = _MARK.match(rest)
        if not m:
            break
        w = m.group(0).strip().lower()
        found.add("planned" if w.startswith("planned") else "approval" if "approval" in w else "unverified" if "unverified" in w else "unconfirmed")
        rest = rest[m.end():]
    return found, rest.strip()


def _add_mark(line: str, mark: str) -> str:
    lead, rest = _split_bullet(line)
    return f"{lead or '- '}{mark} {rest.strip()}"


def _new_rows(body: str, cur_body: str):
    """(rows, keep) where keep holds the normalised lines of `cur_body` (never touched)."""
    return sc._outline(body), {sc.norm(x) for x in (cur_body or "").split("\n") if x.strip()}


def _move_rows(t: sc.Target, rows, decide) -> Tuple[str, Counter]:
    """Apply `decide(sec, line) -> None | ("drop", kind) | ("move", kind, new_line) | ("edit", kind, new_line)`
    to every body bullet row (not the H1 / headings / ## Superseded Decisions); a moved line goes to
    the end of ## Open Threads (a project) or is dropped when the template has no Open Threads."""
    heads = [r[2].split(None, 1)[1].strip() for r in rows if r[1] == 2]
    has_open = OPEN_THREADS in heads
    out_rows, moves, c = [], {}, Counter()
    have_open = {sc.norm(r[2]) for r in rows if r[0] == OPEN_THREADS and r[1] == 0 and r[2].strip()}
    for sec, lvl, line in rows:
        if lvl != 0 or not line.strip() or sec in (None, sc.SUPERSEDED) or not sc._BULLET.match(line):
            out_rows.append((sec, lvl, line))
            continue
        d = decide(sec, line)
        if d is None:
            out_rows.append((sec, lvl, line))
            continue
        act, kind = d[0], d[1]
        if act == "drop" or (act == "move" and not has_open):
            c[f"{kind}_dropped"] += 1
            continue
        new_line = d[2]
        if act == "edit" or sec == OPEN_THREADS:
            c[f"{kind}_marked"] += 1
            out_rows.append((sec, lvl, new_line))
            continue
        c[f"{kind}_moved"] += 1
        moved = new_line.strip()
        if sc.norm(moved) not in have_open:
            moves.setdefault(OPEN_THREADS, []).append(moved)
            have_open.add(sc.norm(moved))
    if not c:
        return "\n".join(r[2] for r in rows), c
    return (_append_to(out_rows, moves) if moves else "\n".join(r[2] for r in out_rows)), c


# ── Superseded hygiene ──────────────────────────────────────────────────────

# A `new` side that says nothing changed: "Same", "Same (merged ...)", "unchanged", "no change",
# "same as before". Only the no-change word itself (+ "as before / as is"), optionally one bracketed
# note without a digit, ':' or a change word: "Same port, HTTPS only", "Kept for now; SearXNG later",
# "Same (now HTTPS only)" or "Kept Brave, SearXNG plan dropped" are real changes.
_NOOP_NEW = re.compile(
    r"^\(?\s*(?:same|unchanged|no change|not changed|identical|as before|kept as is|kept)"
    r"(?:\s+as\s+(?:before|is|above|previously|old|the old one))?\s*\)?"
    r"(?:\s*\((?![^)]*\b(?:but|now|plus|except|only|instead|dropped|removed|added|new|no longer|switched|moved|replaced|changed)\b)[^()0-9:\\]{0,100}\))?"
    r"\s*[.!]?\s*$",
    re.I,
)
_LOG_LINE = re.compile(r"^\s*[\-\*\+]\s+(?:\d{4}-\d{2}-\d{2}:\s*)?(.*?)\s+->\s+(.*?)(?:\s*\((?:arch-[\w-]+|arch-pending)\))?\s*$")
_LABEL_PREFIX = re.compile(r"^([A-Za-z][\w &/-]{0,40}):\s*")


def noop_change(old: str, new: str) -> bool:
    """True when a superseded entry changes nothing: identical sides (after `norm`, and after a
    shared "Label:" prefix), or a `new` side that only says "Same" / "unchanged"."""
    o, n = (old or "").strip(), (new or "").strip()
    if not n or sc.norm(o) == sc.norm(n):
        return True
    mo, mn = _LABEL_PREFIX.match(o), _LABEL_PREFIX.match(n)
    if mo and mn and mo.group(1).strip().lower() == mn.group(1).strip().lower():
        o, n = o[mo.end():], n[mn.end():]
        if sc.norm(o) == sc.norm(n):
            return True
    return bool(_NOOP_NEW.match(n))


def superseded_facts(facts: Sequence[dict], new_scroll: bool = False) -> Tuple[List[dict], Counter]:
    """(facts, removed {kind: n}): a brand-new scroll (no prior version) supersedes nothing, so every
    model-written fact goes ("new_scroll"); a no-op fact always goes ("noop")."""
    out, c = [], Counter()
    for f in facts or []:
        if not isinstance(f, dict):
            out.append(f)
            continue
        if new_scroll:
            c["new_scroll"] += 1
        elif noop_change(str(f.get("old") or ""), str(f.get("new") or "")):
            c["noop"] += 1
        else:
            out.append(f)
    return out, c


def superseded_body(body: str, cur_body: str = "", new_scroll: bool = False) -> Tuple[str, Counter]:
    """(body, removed {kind: n}) for the NEW ## Superseded Decisions lines (a line of `cur_body` is
    never touched): in a brand-new scroll only a host stale-filter log line may stay; a no-op line
    ("X -> Same", identical sides) never stays."""
    rows, keep = _new_rows(body, cur_body)
    out, c = [], Counter()
    for sec, lvl, line in rows:
        if lvl == 0 and sec == sc.SUPERSEDED and sc._BULLET.match(line) and sc.norm(line) not in keep:
            if new_scroll and STALE_LOG_MARK not in line:
                c["new_scroll"] += 1
                continue
            m = _LOG_LINE.match(line)
            if m and noop_change(m.group(1), m.group(2)):
                c["noop"] += 1
                continue
        out.append(line)
    return ("\n".join(out), c) if c else (body, c)


# ── imperatives aimed at an agent (never standing instructions) ─────────────

# Verbs that are an order wherever they start a clause ("delete clutter skills", "remove it").
_IMP_STRONG = r"(?:delete|remove|uninstall|purge|wipe|erase|re-?download|re-?upload|repoint|reconfigure)"
# Verbs that are also nouns ("sync ledger", "export format", "email triage"): an order only with an
# object right after ("send the digest", "export to Google Sheets", "upload it") or alone.
_IMP_SOFT = r"(?:download|upload|export|send|forward|e-?mail|publish|post|back\s*up|backup|sync|push)"
_OBJECT = (r"(?=\s*$|\s+(?:the|a|an|it|them|this|that|these|those|all|every|each|my|his|her|our|your|their|to|out|up|back|over|and|or|then)\b"
           r"|\s+[\w.-]+(?:\s+[\w.-]+)?\s+to\b)")
# The same object minus the bare forms (the end, "and", "or", "then"): in a list of nouns ("chat,
# email and calendar", "backup, sync and export") a verb with no real object is a noun, not an order.
_OBJECT_REAL = (r"(?=\s+(?:the|a|an|it|them|this|that|these|those|all|every|each|my|his|her|our|your|their|to|out|up|back|over)\b"
                r"|\s+[\w.-]+(?:\s+[\w.-]+)?\s+to\b)")
_IMP_LEAD = r"(?:(?:then|and|also|please|next|todo|to-?do|pending|needs?(?:\s+to)?|should|must|have\s+to|has\s+to|go|try\s+to|let'?s|we\s+should|you\s+should|to)\s+)*"
# The verb as a noun ("Post-processing", "Send button", "Download speeds are slow") is not an order.
_NOT_ORDER = (r"(?![-:])(?!\s+(?:is|are|was|were|has|had|failed|fails|works|worked|speeds?|size|times?|errors?|links?|buttons?|paths?|folders?"
              r"|formats?|steps?|queues?|jobs?|logs?|modes?|options?|status)\b)")
_IMP_VERB = r"(?:" + _IMP_STRONG + r"|" + _IMP_SOFT + r")"
_IMP_CLAUSE = re.compile(r"^\W*" + _IMP_LEAD + r"(?:(?:re-?)?" + _IMP_STRONG + r"\b" + _NOT_ORDER + r"|" + _IMP_SOFT + r"\b" + _NOT_ORDER + _OBJECT + r")", re.I)
_CONFIG_CLAUSE = re.compile(r"^\W*" + _IMP_LEAD + r"(?:change|edit|update|modify|set|switch|rewrite|replace)\b[^\n]{0,50}"
                            r"\b(?:config\w*|settings?|\.json|\.env|\.toml|\.ya?ml|mcp\s+(?:entry|entries|config|server)|registry)\b", re.I)
_EXTERNAL = re.compile(r"\b(?:google\s+(?:drive|sheets?|docs?)|dropbox|one\s?drive|icloud|external\s+(?:drive|disk|ssd|hdd)|usb\s+(?:drive|stick)|github|gmail|s3|cloud\s+storage)\b", re.I)
_EXT_ACTION = re.compile(r"\b(?:back\s*up|backup|upload|export|sync|copy|save|push|send|share|post|move)\b", re.I)
_EXT_TODO = re.compile(r"\b(?:pending|needed|needs?|todo|to-?do|next|planned|should|must|to be|make|create|take|schedule|do)\b", re.I)
# A clause that states a rule about such an action, not a to-do: negated or gated on approval.
_RULE_GATE = re.compile(r"\b(?:never|don'?t|do not|does not|doesn'?t|no|not|nothing|none|no-?one|nobody|nowhere|neither|nor|without|only (?:after|with|when|if)|ask (?:first|before)|before \w+ing|approv\w*|confirm\w*|read-?back|refuse\w*|forbidden|blocked)\b", re.I)
# A bullet that says such an action is switched off states a rule / state, not a to-do.
_STATE_OFF = re.compile(r"\b(?:are|is|stays?|stay|kept|turned|switched)\s+(?:off|disabled|blocked|refused|read-only)\b", re.I)
# Sentences (; and .), then clauses (, and before a chained order: "... and re-download"); never
# inside brackets (a parenthesised list names things: "(email, messages, calendar)"). A rule gate
# anywhere in a sentence covers its whole list ("No write, embed, upload, or delete path.").
_SENTENCES = re.compile(r"[;.]\s+|[;.]$")
_CLAUSES = re.compile(r",\s+|\s+(?:and then|then|and)\s+(?=(?:re-?)?" + _IMP_VERB + r"\b)", re.I)
_BRACKETS = re.compile(r"\([^()\n]*\)|`[^`\n]*`")
_BOLD_LABEL = re.compile(r"^\*\*([^*\n]{1,80}?)\s*:?\s*\*\*\s*:?\s*")
# A clause whose order needs a real object (strong verb, or soft verb + object) vs. a clause that
# starts with any action verb (used to tell "Back up and sync" from "chat, email and calendar").
_IMP_WITH_OBJECT = re.compile(r"^\W*" + _IMP_LEAD + r"(?:(?:re-?)?" + _IMP_STRONG + r"\b" + _NOT_ORDER + r"|" + _IMP_SOFT + r"\b" + _NOT_ORDER + _OBJECT_REAL + r")", re.I)
_VERB_START = re.compile(r"^\W*" + _IMP_LEAD + r"(?:(?:re-?)?" + _IMP_VERB
                         + r"|change|edit|update|modify|set|switch|rewrite|replace|fix|check|verify|test|run|build|make|add|move|copy|review|install)\b", re.I)


# Rule, identity, prompt and config files (v5): an order to edit / fix / lock / rewrite one is an agent
# imperative that needs Nic's approval (hub AGENTS_NEVER: never change rules or identity files).
_RULE_FILE = re.compile(
    r"\b(?:master_identity(?:\.md)?|agents_never(?:\.md)?|agents\.md|claude\.md|gemini\.md|soul\.md|constitution(?:\.md)?|rules?(?:\.md)?"
    r"|identity(?:\s+files?)?|(?:system\s+)?prompts?|configs?|config\s+files?|personas?)(?![\w-])|\.clinerules\b", re.I)
_RULE_EDIT_VERB = r"(?:edit|fix|lock|unlock|rewrite|write|change|update|modify|amend|revise|correct|patch|tweak|replace|overwrite|finali[sz]e)"
_RULE_EDIT_CLAUSE = re.compile(r"^\W*" + _IMP_LEAD + _RULE_EDIT_VERB + r"\b(?![-:])", re.I)
_RULE_EDIT_SPLIT = re.compile(r",\s+|\s+(?:and then|then|and)\s+(?=" + _RULE_EDIT_VERB + r"\b)", re.I)
# A plan line that states the edit as done ("Planned: MASTER_IDENTITY v1 reviewed and locked").
_RULE_EDIT_DONE = re.compile(r"\b(?:edited|fixed|locked|unlocked|rewritten|written|changed|updated|modified|amended|revised|corrected|patched|finali[sz]ed)\b", re.I)

# v6: a passive / modal order ("AnythingLLM MCP entry must be repointed manually", "the cache needs to be
# deleted by hand") is an agent imperative like its active form. Not a rule about how it happens ("must be
# updated atomically / only via approve() / before ..."): those state a constraint, not a to-do. A gated
# sentence (never, not, without, approval ...) is skipped before this check, as for the active form.
_PASSIVE_VERB = (r"(?:re-?pointed|reconfigured|changed|edited|updated|deleted|removed|uninstalled|purged|wiped|erased|uploaded|re-?uploaded|exported"
                 r"|sent|synced|pushed|backed\s+up|re-?downloaded|moved|renamed|installed)")
# Round 10: no bare "to be" ("turned out / used / seems / is expected / is scheduled to be installed" are
# facts, not orders); a schedule ("nightly", "daily", "each night") is a how-rule; and an order addressed
# to Nic ("Drafts are to be sent by Nic", "... moved to a review label for Nic") is not an agent's to-do.
_PASSIVE_ORDER = re.compile(
    r"\b(?:must|should|needs?\s+to|has\s+to|have\s+to|ought\s+to|is\s+to|are\s+to)\s+be\s+(?:(?:manually|by\s+hand|still|also|then)\s+)*" + _PASSIVE_VERB
    + r"\b(?!\s+(?:atomically|safely|automatically|via|through|using|only|before|after|first|when|whenever|if|together|in\s+place|on\s+(?:every|each)"
      r"|nightly|daily|weekly|hourly|monthly|regularly|periodically|(?:each|every)\s+\w+)\b)",
    re.I)
_PASSIVE_FOR_NIC = re.compile(r"\b(?:by|for)\s+(?:nic|the\s+user|the\s+operator)\b", re.I)


def _passive_order(sentence: str) -> bool:
    """True when `sentence` holds a passive / modal agent order (`_PASSIVE_ORDER`) not addressed to Nic."""
    m = _PASSIVE_ORDER.search(sentence)
    return bool(m) and not _PASSIVE_FOR_NIC.search(sentence[m.end():])


# v6: a Planned: (roadmap) line about curating / pruning / cleaning up / deleting files, or testing every MCP
# (that covers the messaging and account MCPs), needs Nic's approval like an order to do it.
_PLAN_APPROVAL = re.compile(
    r"\b(?:curat(?:e|es|ing|ion|ions)\b|prun\w*|clean(?:ing|s|ed)?[\s-]*up|cleanups?|declutter\w*|de-?clutter\w*|delet\w*|purg\w*|wip(?:e|es|ing)\b|trash\w*)"
    r"|\btest(?:s|ing)?\s+(?:all|every|each)\s+(?:of\s+the\s+|the\s+)?(?:[\w.-]+\s+)?mcps?\b",
    re.I)

_PLAN_GATE = re.compile(r"\b(?:never|nothing|none|nobody|no-?one|without|only\s+(?:after|with|when|if|once)|approv\w*)\b", re.I)


def plan_needs_approval(text: str) -> bool:
    """True when a plan line (marks allowed) is about curating / pruning / deleting files or testing all MCPs."""
    _, rest = _marks(_split_bullet(text)[1])
    # Round 10: a sentence that states a rule ("nothing is ever deleted", "... only after Nic approves")
    # is not a plan to do it; "curated seed sources" is an adjective, not a curation job.
    return any(_PLAN_APPROVAL.search(x) and not _PLAN_GATE.search(x) for x in _SENTENCES.split(_BRACKETS.sub(" ", rest)))


def rule_file_edit(text: str) -> bool:
    """True when `text` (a bullet, marks and label allowed) tells an agent to edit / fix / lock / rewrite
    a rule, identity, prompt or config file (or, as a "Planned:" line, states such an edit). A rule about
    it ("Never change rules or identity files", "... with Nic's approval") is not an order."""
    found, rest = _marks(_split_bullet(text)[1])
    if not _RULE_FILE.search(rest):
        return False
    flat = _BRACKETS.sub(" ", rest.replace("**", " "))
    for sentence in _SENTENCES.split(flat):
        if not sentence.strip() or _RULE_GATE.search(sentence):
            continue
        clauses = [c.strip() for c in _RULE_EDIT_SPLIT.split(sentence) if c and c.strip()]
        if any(_RULE_EDIT_CLAUSE.match(c) for c in clauses):
            return True
        if "planned" in found and _RULE_FILE.search(sentence) and _RULE_EDIT_DONE.search(sentence):
            return True
    return False


def imperative_kind(text: str) -> Optional[str]:
    """"agent_action" / "config_change" / "external" / "rule_file_edit" when `text` (a bullet, label
    allowed) tells an agent to delete / remove / download / upload / export / send / change config, touch
    an outside service or edit a rule / identity / prompt / config file; None for a rule about such
    actions ("Never delete files", "ask before sending"), a state ("Send, reply and trash are OFF") or a
    noun ("sync ledger", "Send button")."""
    kind = _imperative_kind_v4(text)
    if kind is None and rule_file_edit(text):
        return "rule_file_edit"
    return kind


def _imperative_kind_v4(text: str) -> Optional[str]:
    _, rest = _marks(_split_bullet(text)[1])
    label = ""
    b = _BOLD_LABEL.match(rest)
    if b:
        label, rest = b.group(1), rest[b.end():]
    m = _LABEL_PREFIX.match(rest)
    if m:
        # A "Label:" names the topic ("Sync: ...", "Catalog: ..."), never the action.
        label, rest = f"{label} {m.group(1)}".strip(), rest[m.end():]
    if _STATE_OFF.search(rest):
        return None
    flat = _BRACKETS.sub(" ", rest)
    label_gate = bool(label) and bool(_RULE_GATE.search(_BRACKETS.sub(" ", label)))
    for i, sentence in enumerate(_SENTENCES.split(flat)):
        # A rule gate in the stripped label covers the first sentence (the list it introduces):
        # "**approve() still gates every mutating plan:** email, messages, calendar".
        if _RULE_GATE.search(sentence) or (i == 0 and label_gate):
            continue
        if _passive_order(sentence):
            return "agent_action"  # v6: "... must be repointed manually"
        clauses =[c.strip() for c in _CLAUSES.split(sentence) if c and c.strip()]
        # A verb with no object ("email", "sync and") is an order only alone or when every clause of
        # the sentence starts with a verb ("Back up and sync"); among nouns it is a noun.
        bare_ok = len(clauses) == 1 or all(_VERB_START.match(c) for c in clauses)
        for clause in clauses:
            if _CONFIG_CLAUSE.match(clause):
                return "config_change"
            if _IMP_CLAUSE.match(clause) and (bare_ok or _IMP_WITH_OBJECT.match(clause)):
                return "agent_action"
    if _EXTERNAL.search(rest) and _EXT_ACTION.search(rest) and _EXT_TODO.search(rest) and not _RULE_GATE.search(rest):
        return "external"
    return None


def imperatives_body(t: sc.Target, body: str, cur_body: str = "", idx: Optional["PlanIndex"] = None) -> Tuple[str, Counter]:
    """(body, counts): a NEW bullet that instructs an agent to act on files, config or an outside
    service is never a standing instruction: in a project it moves to ## Open Threads prefixed
    "(needs Nic's approval)"; anywhere else (Lessons, identity, architecture) it is dropped. v6: so does a
    plan line ("Planned:" or a restated plan of `idx`) about curating / pruning / deleting files or testing
    all MCPs (`plan_needs_approval`)."""
    rows, keep = _new_rows(body, cur_body)

    def decide(sec, line):
        if sc.norm(line) in keep:
            return None
        found, _ = _marks(_split_bullet(line)[1])
        marked = "approval" in found
        plan = "planned" in found or bool(idx and idx.from_plan(line))
        if not marked and imperative_kind(line) is None and not (plan and plan_needs_approval(line)):
            return None
        if t.kind != "project":
            return ("drop", "imperative")
        if marked and sec == OPEN_THREADS:
            return None
        return ("move", "imperative", line if marked else _add_mark(line, NEEDS_APPROVAL))

    return _move_rows(t, rows, decide)


# ── plans (ROADMAP and other plan / goal files) never state achievements ────

PLAN_FILE = re.compile(r"(?:^|/)(?:roadmap|plans?|goals?|backlog|todos?|to-do)[^/]*\.md$", re.I)
_WORD = re.compile(r"[a-z0-9][a-z0-9.+_-]*")
_PLAN_STOP = frozenset("the a an and or of to in on for with by is are be as at from this that it its not no into under over each every only one per "
                       "planned plan phase goal goals done complete completed ready".split())


def _cwords(text: str) -> set:
    _, rest = _marks(_split_bullet(text)[1])
    out = set()
    for w in _WORD.findall(rest.lower()):
        w = w.strip(".-_+")
        if len(w) < 2 or w in _PLAN_STOP:
            continue
        out.add(w[:-1] if len(w) > 3 and w.endswith("s") else w)
    return out


class PlanIndex:
    """Content words of every plan line (ROADMAP / plan / goal files) and every other (dated status)
    line of the same batch, for `plans_body` / `plans_entities`. Held in memory only."""

    def __init__(self, plan_lines: Iterable[str] = (), status_lines: Iterable[str] = (), source_lines: Optional[Iterable[str]] = None,
                 settled: Iterable[str] = ()):
        plan_lines, status_lines = list(plan_lines or ()), list(status_lines or ())
        self.plan = [w for w in (_cwords(x) for x in plan_lines) if len(w) >= 2]
        self.status = [w for w in (_cwords(x) for x in status_lines) if len(w) >= 2]
        # v6: every line of the batch, lower-case and whitespace-folded (the KG cross-tool check).
        self.lines: Tuple[str, ...] = tuple(re.sub(r"\s+", " ", x).lower() for x in plan_lines + status_lines)
        # v5: every modal sentence of the batch's sources (None: the rule-support check is off, e.g. a
        # batch with chat sources the apply-time re-read cannot see), the settled AGENTS_NEVER rules (raw
        # item text) and a read-only path probe `probe(token) -> True / False / None` (set by the caller).
        self.support: Optional[SupportIndex] = SupportIndex(source_lines) if source_lines is not None else None
        self.settled: Tuple[str, ...] = tuple(settled)
        self.probe = None

    def __bool__(self) -> bool:
        return bool(self.plan)

    @staticmethod
    def _best(words: set, lines: List[set]) -> float:
        """Share of `words` covered by the lines that each share at least 2 of them (a bullet may merge
        two plan lines: "backed up twice; X and Y reviewed")."""
        hit = set().union(*[words & p for p in lines if len(words & p) >= 2]) if lines else set()
        return len(hit) / len(words) if words else 0.0

    def from_plan(self, text: str) -> bool:
        """True when `text` restates plan lines (>= 60 % of its content words, at least 2 per line) better
        than the status lines do (when STATUS and ROADMAP disagree, the dated status wins)."""
        w = _cwords(text)
        if len(w) < 2 or not self.plan:
            return False
        p = self._best(w, self.plan)
        return p >= 0.6 and p > self._best(w, self.status)


_PLANNED_LEAD = re.compile(r"^\s*(?:(?:[\-\*\+]|\d+[.)])\s+)?(?:\(unconfirmed\)\s*|\(needs nic['’]s approval\)\s*)*planned\s*:", re.I)


def plan_lines(records: Sequence[dict], support: bool = True) -> PlanIndex:
    """The PlanIndex of a batch: lines of records whose meta says `plan`, and every line tagged
    "Planned:" (a to-do section of a status file, e.g. STATUS "Next steps"), vs the other hub / doc
    lines (a to-do is never the dated status that wins over a roadmap goal).

    v5: every hub / doc line also feeds the rule-support index (`support=False`: off, for a batch whose
    sources `--apply` cannot re-read), and the NEVER items of the hub AGENTS_NEVER.md the settled
    guardrails."""
    plans, status, lines, settled = [], [], [], []
    for r in records or []:
        meta = r.get("meta") or {}
        if meta.get("hint") not in ("hub", "repo"):
            continue
        text = str(r.get("text") or "")
        if meta.get("hint") == "hub" and meta.get("file") == SETTLED_FILE:
            settled += settled_items(text)
        for x in text.split("\n"):
            if not x.strip() or x.lstrip().startswith("#"):
                continue
            lines.append(x)
            (plans if meta.get("plan") or _PLANNED_LEAD.match(x) else status).append(x)
    return PlanIndex(plans, status, lines if support else None, settled)


def plans_body(t: sc.Target, body: str, cur_body: str = "", idx: Optional[PlanIndex] = None) -> Tuple[str, Counter]:
    """(body, counts): a NEW bullet that restates a plan line (or carries "Planned:") is never an
    achievement: it moves to ## Open Threads prefixed "Planned:" (dropped where there is none)."""
    rows, keep = _new_rows(body, cur_body)

    def decide(sec, line):
        if sc.norm(line) in keep:
            return None
        found, _ = _marks(_split_bullet(line)[1])
        marked = "planned" in found
        if not marked and not (idx and idx.from_plan(line)):
            return None
        if t.kind != "project":
            return ("drop", "plan")
        if marked and sec == OPEN_THREADS:
            return None
        return ("move", "plan", line if marked else _add_mark(line, PLANNED))

    return _move_rows(t, rows, decide)


# ── transient status and Key Paths ──────────────────────────────────────────

# After an online / offline status word: the end of the clause or a time ("since 07:43", "now").
# Not a hyphen or a noun ("offline-first", "offline-only", "offline mode", "= offline blocks ..."),
# and not a bracketed design note ("are offline (no cloud calls)"): those are standing design facts.
_STATUS_END = r"(?![\w-])(?=\s*(?:$|[.,;:!?)]|\((?:\s*(?:since|at|as of|\d))|(?:now|right now|today|at|since|as of|again)\b))"
_TRANSIENT = re.compile(
    r"\(\s*(?:online|offline)(?![\w-])"
    r"|\b(?:status|state|agent|system|server|service)\s*[:=]\s*(?:currently\s+)?(?:online|offline|up|down|running|stopped|responsive|unresponsive|idle|busy)"
    + _STATUS_END +
    r"|\b(?:is|are)\s+currently\s+(?:online|offline)(?![\w-])"
    r"|\b(?:is|are)\s+(?:online|offline)" + _STATUS_END +
    r"|\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}"
    r"|\b(?:as of|last checked|checked at)\s+\d"
    r"|\b(?:last\s+)?(?:updated|rewritten|edited|written|refreshed)\s+(?:fresh\s+)?(?:on\s+)?\d{4}-\d{2}-\d{2}\b"
    r"|\blast\s+(?:updated|edited|session|run)\s*[:=]\s*\d{4}-\d{2}-\d{2}\b"
    r"|\b(?:today|tonight|this morning|right now)\b",
    re.I,
)
PATH_SECTIONS = ("Key Paths", "Repo Paths")
_PATH_TOKEN = re.compile(
    r"[A-Za-z]:[\\/]|(?:^|[\s`(\"'])(?:~|\.{1,2})?/[\w.$<>-]|\b[\w.$<>-]+[\\/](?:[\w.$<>-]|(?=[\s`),;]|$))"
    r"|\b[\w-]+\.(?:md|json|jsonl|py|rs|ts|tsx|js|db|sqlite|toml|ya?ml|cmd|ps1|sh|txt|log|gz|exe|env)\b|%[A-Z_]+%|\$[A-Z_]+|https?://|:\d{4,5}\b|\blocalhost\b|\b127\.0\.0\.1\b",
)
# A label naming what a path holds -> what that path must look like.
_LABEL_NEEDS = (
    (re.compile(r"^\s*(?:local\s+)?(?:llm\s+)?models?(?:\s+(?:dir|folder|store|path|root))?\s*:", re.I),
     re.compile(r"models?\b|\.lmstudio|lm[ -]?studio|\.cache[\\/]huggingface|huggingface|ollama|\.gguf|safetensors|whisper|kokoro|piper|voices?\b", re.I)),
)


def transient_kind(text: str) -> bool:
    _, rest = _marks(_split_bullet(text)[1])
    return bool(_TRANSIENT.search(rest))


def wrong_path_label(text: str) -> bool:
    """True when a "Models:" (or similar) label points at a path that is not that kind of store."""
    _, rest = _marks(_split_bullet(text)[1])
    for label, need in _LABEL_NEEDS:
        m = label.match(rest)
        if m and not need.search(rest[m.end():]):
            return True
    return False


def status_paths_body(t: sc.Target, body: str, cur_body: str = "") -> Tuple[str, Counter]:
    """(body, counts): NEW bullets with transient status (online / offline, a timestamp) are dropped;
    under Key Paths / Repo Paths a bullet with a wrongly labelled path is dropped and a bullet with no
    path at all leaves the section (to ## Active State in a project; dropped otherwise)."""
    rows, keep = _new_rows(body, cur_body)
    heads = [r[2].split(None, 1)[1].strip() for r in rows if r[1] == 2]
    out, moves, c = [], {}, Counter()
    for sec, lvl, line in rows:
        if lvl != 0 or not line.strip() or sec in (None, sc.SUPERSEDED) or not sc._BULLET.match(line) or sc.norm(line) in keep:
            out.append((sec, lvl, line))
            continue
        if transient_kind(line):
            c["transient_dropped"] += 1
            continue
        if sec in PATH_SECTIONS:
            if wrong_path_label(line):
                c["path_label_dropped"] += 1
                continue
            if not _PATH_TOKEN.search(_marks(_split_bullet(line)[1])[1]):
                if t.kind == "project" and "Active State" in heads:
                    moves.setdefault("Active State", []).append(line.strip())
                    c["no_path_moved"] += 1
                else:
                    c["no_path_dropped"] += 1
                continue
        out.append((sec, lvl, line))
    if not c:
        return body, c
    return (_append_to(out, moves) if moves else "\n".join(r[2] for r in out)), c


def content_entities(entities: Sequence[dict], idx: Optional[PlanIndex] = None) -> Tuple[List[dict], Counter]:
    """KG observations that are agent imperatives, plan lines (stated as facts) or transient status
    are dropped; an entity left with none goes too. v5: an install / config approval is corrected to
    Nic (or the observation is "(unconfirmed)"), a safety-critical term gets its qualifier (or the
    observation goes), and a storage path that does not exist is "(planned, not created yet)"."""
    out, c = [], Counter()
    probe = getattr(idx, "probe", None) if idx is not None else None
    for e in entities or []:
        obs = e.get("observations") if isinstance(e, dict) else None
        if not isinstance(obs, list) or not obs:
            out.append(e)
            continue
        # Round 10: a scope suffix the cross-target merge adds ("modes.json (Agentic OS)") is not part of
        # the path: the name is typed and probed without it, as the dry-run did before the rename.
        full = str(e.get("name") or "")
        name = kg_base_name(full)
        if e.get("entityType") == "path" and not path_like_name(name):
            e = {**e, "entityType": "concept"}  # v6: a machine name or a label ("preview-dir") is not a path
            c["path_type_retyped"] += 1
        # v6: the NAME is probed only when it looks like a real path or file ("preview-dir" is a label).
        planned_path = (bool(probe) and path_like_name(name) and (e.get("entityType") == "path" or bool(_STORE_EXT.search(name.strip("`\\/ "))))
                        and _probe(probe, name.strip("` ")) is False)
        tool = e.get("entityType") in ("tool", "service") or any(_tool_key(full) == _tool_key(k) for k in KNOWN_TOOLS)
        kept = []
        for o in obs:
            if not isinstance(o, str):
                kept.append(o)
            elif tool and _foreign_tool(full, o, idx):
                c["foreign_tool_kg"] += 1
            elif imperative_kind(o):
                c["imperative_kg"] += 1
            elif "planned" in _marks(o)[0] or (idx and idx.from_plan(o)):
                c["plan_kg"] += 1
            elif transient_kind(o):
                c["transient_kg"] += 1
            else:
                new, act = approver_fix(o)
                if act == "rewrite":
                    o = new
                    c["approver_kg_rewritten"] += 1
                elif act == "demote" and stc.unconfirmed(o) != o:
                    o = stc.unconfirmed(o)
                    c["approver_kg_demoted"] += 1
                new, act = qualify(o)
                if act == "drop":
                    c["qualifier_kg_dropped"] += 1
                    continue
                if act == "append":
                    o = new
                    c["qualifier_kg_appended"] += 1
                # v6: the marker is only ever a prefix of the whole observation, never spliced into it.
                if probe and PLANNED_NOT_CREATED not in o and (planned_path or annotate_paths(o, probe, False) is not None):
                    o = f"{PLANNED_NOT_CREATED} {o}"
                    c["path_planned_kg"] += 1
                kept.append(o)
        if kept:
            out.append({**e, "observations": kept} if kept != obs else e)
    return out, c


# v6: a path-like entity name (a separator, a drive / %VAR% root or a known file extension).
_KNOWN_EXT = re.compile(r"\.(?:db|sqlite3?|json|jsonl|md|py|rs|ts|tsx|js|toml|ya?ml|cmd|ps1|sh|txt|log|gz|exe|env|cfg|ini)$", re.I)


# Round 10: the scope label offload's cross-target merge appends ("modes.json (Agentic OS)"): a trailing
# "( ... )" holding no path character. Stripped only when what is left is a path-like name.
_KG_SCOPE_LABEL = re.compile(r"\s+\([^()\\/.:]*\)\s*$")


def kg_base_name(name: str) -> str:
    """`name` without a trailing scope label when the rest is a path-like name, else `name`."""
    cut = _KG_SCOPE_LABEL.sub("", name or "").strip()
    return cut if cut and cut != (name or "").strip() and path_like_name(cut) else (name or "")


def path_like_name(name: str) -> bool:
    n = (name or "").strip().strip("`'\"").rstrip(".,:;")
    return bool(re.search(r"[\\/]", n) or re.match(r"^(?:[A-Za-z]:|%[A-Za-z_]+%)", n) or _KNOWN_EXT.search(n))


# v6: tools whose names the model mixes up across entities ("AnythingLLM: Has Playwright MCP for Claude
# Code", where the source gives that MCP to Claude Code). Static, so the dry-run and --apply agree.
KNOWN_TOOLS = ("Claude Code", "Claude Desktop", "Cline", "AnythingLLM", "LM Studio", "VS Code", "Cursor", "Codex", "Gemini CLI", "Ollama",
               "Open WebUI", "Antigravity", "Command Center")
_KG_SCOPE = re.compile(r"\s*\([^()]*\)\s*$")


def _tool_key(name: str) -> str:
    return re.sub(r"\s+", " ", _KG_SCOPE.sub("", name or "")).strip().lower()


def _foreign_tool(name: str, text: str, idx: Optional["PlanIndex"]) -> Optional[str]:
    """The other known tool an observation of entity `name` attributes something to ("... for Claude
    Code"), unless a source line of `idx` names both; else None."""
    own = _tool_key(name)
    if not own:
        return None
    for tool in KNOWN_TOOLS:
        k = _tool_key(tool)
        if k == own or k in own or own in k:
            continue
        if re.search(r"\bfor\s+(?:the\s+)?" + r"\s+".join(map(re.escape, k.split())) + r"(?![\w-])", text, re.I):
            lines = getattr(idx, "lines", None) or ()
            if not any(own in x and k in x for x in lines):
                return tool
    return None


# ── v5 fidelity guards ──────────────────────────────────────────────────────


def _relocate(t: sc.Target, rows, decide) -> Tuple[str, Counter]:
    """Apply `decide(sec, line) -> None | ("drop", kind) | ("edit", kind, new_line) | ("demote", kind,
    new_line)` to every body bullet row (not headings / ## Superseded Decisions): a demoted line under a
    locked heading moves to the end of the kind's unconfirmed heading (`UNCONFIRMED_TO`; dropped when
    the template has none), anywhere else it is edited in place."""
    heads = [r[2].split(None, 1)[1].strip() for r in rows if r[1] == 2]
    dest = _dest(t, heads)
    out_rows, moves, c = [], {}, Counter()
    dest_have = {sc.norm(r[2]) for r in rows if r[0] == dest and r[1] == 0 and r[2].strip()}
    for sec, lvl, line in rows:
        if lvl != 0 or not line.strip() or sec in (None, sc.SUPERSEDED) or not sc._BULLET.match(line):
            out_rows.append((sec, lvl, line))
            continue
        d = decide(sec, line)
        if d is None:
            out_rows.append((sec, lvl, line))
            continue
        act, kind = d[0], d[1]
        if act == "drop":
            c[f"{kind}_dropped"] += 1
            continue
        new_line = d[2]
        if act == "demote" and sec in sc.LOCKED_HEADINGS:
            if not dest:
                c[f"{kind}_dropped"] += 1
                continue
            c[f"{kind}_demoted"] += 1
            moved = new_line.strip()
            if sc.norm(moved) not in dest_have:
                moves.setdefault(dest, []).append(moved)
                dest_have.add(sc.norm(moved))
            continue
        c[f"{kind}_{'demoted' if act == 'demote' else 'edited'}"] += 1
        out_rows.append((sec, lvl, new_line))
    if not c:
        return "\n".join(r[2] for r in rows), c
    return (_append_to(out_rows, moves) if moves else "\n".join(r[2] for r in out_rows)), c


def _renamed(c: Counter, old: str, new: str) -> Counter:
    return Counter({(new if k == old else k): v for k, v in c.items()})


# (1) Approver fidelity. Hub AGENTS_NEVER / AGENTS.md: agents propose, the Librarian checks, Nic approves.
# An install / skill / MCP / package / config rule that names an agent as the approver is corrected to Nic
# ("without Librarian approval" -> "without Nic's approval (proposed through the Librarian)"), a bare
# "without approval" there names Nic, and "the Librarian approves ..." (no safe rewrite) is demoted.
_APPROVER_AGENTS = _alt(AGENT_NAMES | {"agent", "agents", "another agent"})
_APPROVER_SCOPE = re.compile(r"\b(?:un)?install\w*|\b(?:skills?|mcps?|packages?|plugins?|extensions?|dependenc(?:y|ies)|config\w*|settings?)\b", re.I)
_APPROVAL_WORD = re.compile(r"approv\w*|sign-?off|go-?ahead|consent", re.I)
_AGENT_APPROVAL = re.compile(r"\b(?:the\s+|an?\s+)?(?P<agent>" + _APPROVER_AGENTS + r")(?:['’]s)?\s+(?P<what>approval|sign-?off|go-?ahead|consent)\b", re.I)
_APPROVED_BY_AGENT = re.compile(r"\bapproved\s+by\s+(?:the\s+|an?\s+)?(?P<agent>" + _APPROVER_AGENTS + r")\b(?!\s*\))", re.I)
_AGENT_APPROVES = re.compile(r"\b(?:" + _APPROVER_AGENTS + r")\s+(?:approves|signs\s+off|authori[sz]es)\b", re.I)
_BARE_APPROVAL = re.compile(r"\bwithout\s+(?:(?:prior|explicit|written)\s+)?approval\b", re.I)
_NIC_APPROVER = re.compile(
    r"\b(?:nic|the user|the operator)(?:['’]s)?\s+(?:(?:explicit|written)\s+)?(?:approval|sign-?off|go-?ahead|ok)\b|\b(?:nic|the user)\s+approves\b|\bapproved\s+by\s+nic\b", re.I)


# Round 9: an agent's approval that the text itself denies ("the Librarian's approval is not enough",
# "on an agent's approval alone", "not the Coder's sign-off") is already the rule: never rewritten. Any
# other negation after it ("the Librarian's approval is not required") has no safe rewrite: demoted.
_APPROVAL_DENIED_AFTER = re.compile(
    r"^[^.;:!?\n]{0,40}?(?:\balone\b|(?:\bnot|\bnever|n['’]t)\s+(?:\w+\s+)?(?:enough|sufficient|adequate|valid|count\w*)\b|\binsufficient\b|\bnever\s+counts?\b)", re.I)
_APPROVAL_DENIED_BEFORE = re.compile(r"\b(?:not|never|nor|no)\s+(?:just\s+|only\s+|merely\s+|even\s+|simply\s+)?(?:on\s+|by\s+|with\s+)?$", re.I)
_APPROVAL_NEG_AFTER = re.compile(r"^[^.;:!?\n]{0,40}?(?:\b(?:not|never|no\s+longer)\b|n['’]t\b)", re.I)


def approver_fix(text: str) -> Tuple[Optional[str], str]:
    """(corrected text, "rewrite") / (None, "demote") / (None, "") for an install / config approval rule."""
    if not isinstance(text, str) or not _APPROVER_SCOPE.search(text) or not _APPROVAL_WORD.search(text):
        return None, ""
    unsafe = []

    def fix(m: "re.Match[str]", repl: str) -> str:
        before, after = m.string[:m.start()], m.string[m.end():]
        if _APPROVAL_DENIED_AFTER.match(after) or _APPROVAL_DENIED_BEFORE.search(before):
            return m.group(0)
        if _APPROVAL_NEG_AFTER.match(after):
            unsafe.append(m.group(0))
            return m.group(0)
        return repl

    new = _AGENT_APPROVAL.sub(lambda m: fix(m, f"Nic's {m.group('what').lower()} (proposed through the {m.group('agent')})"), text)
    new = _APPROVED_BY_AGENT.sub(lambda m: fix(m, f"approved by Nic (proposed through the {m.group('agent')})"), new)
    if unsafe or _AGENT_APPROVES.search(new):
        return None, "demote"
    if _BARE_APPROVAL.search(new) and not _NIC_APPROVER.search(new):
        new = _BARE_APPROVAL.sub(lambda m: m.group(0)[: -len("approval")] + "Nic's approval", new, count=1)
    return (new, "rewrite") if new != text else (None, "")


def approver_body(t: sc.Target, body: str, cur_body: str = "") -> Tuple[str, Counter]:
    """(body, counts): a NEW install / config rule names Nic as the approver (rewritten in place), or
    is demoted "(unconfirmed)" out of the locked sections (dropped from Lessons and Fixes)."""
    rows, keep = _new_rows(body, cur_body)

    def decide(sec, line):
        if sc.norm(line) in keep:
            return None
        new, act = approver_fix(line)
        if act == "rewrite":
            return ("edit", "approver", new)
        if act != "demote":
            return None
        if t.kind == "pattern":
            return ("drop", "approver")
        marked = stc.unconfirmed(line)
        if marked == line and sec not in sc.LOCKED_HEADINGS:
            return None
        return ("demote", "approver", marked)

    body, c = _relocate(t, rows, decide)
    return body, _renamed(c, "approver_edited", "approver_rewritten")


# (2) Settled guardrails: the NEVER items of the hub AGENTS_NEVER.md (after the Booking, privacy and
# scrub filters the hub source already passed) are copied by the host into ## Guardrails as standalone
# bullets: one per item, its NEVER sentence plus what fits (SETTLED_MAX_ITEM), a sentence holding a
# stale or contested claim left out (a contested one stays in its own "(unconfirmed)" bullet), the
# approver fixed (1). A NEW model bullet restating one under ## Guardrails is replaced by the host copy
# (only when the host text holds nearly all its words; else both stay); a bullet elsewhere never stands
# for it (round 9: the host copy is always added); a contested / unverified / planned bullet never does
# (a contested demotion never swallows a settled rule). Capped (count and bytes).
SETTLED_FILE = "master/AGENTS_NEVER.md"
GUARDRAILS = "Guardrails"
SETTLED_MAX_ITEM = 180
SETTLED_MAX_FIRST = 240
SETTLED_MAX_BULLETS = 15
SETTLED_MAX_BYTES = 1800
_SETTLED_HEAD = re.compile(r"^\s*#{1,6}\s+(.*?)\s*#*\s*$")
_SETTLED_ITEM = re.compile(r"^\s*(?:\d+[.)]|[\-\*\+])\s+(.*\S)\s*$")
_SETTLED_SPLIT = re.compile(r"(?<=[.!?])\s+")
_CONTESTED_SENTENCE = re.compile(
    r"(?<!read-)(?<!read )\b(?:only|sole)\b[^\n]{0,25}\blibrarian\b|\blibrarian\b[^\n]{0,25}(?<!read-)(?<!read )\b(?:only|sole)\b", re.I)
# Round 10: in a MODEL bullet (and when telling which "(unconfirmed)" bullet carries the claim) a
# `_CONTESTED_SENTENCE` hit is contested #4 only when the "only / sole" binds to the Librarian's
# authority: "only (through / via / by) (the) Librarian" ending the clause, followed by its approval or by
# a write verb; "the Librarian is the only / sole <writer, agent for rules ...>"; "the Librarian alone /
# only <writes ...>". Not "the only layer synced into the librarian workspace", "the Librarian model only
# condenses ...", "... the Librarian checks them and only Nic approves", "Librarian only reads".
_CONTESTED_BOUND = re.compile(
    r"(?<!not )(?<!read-)(?<!read )\b(?:only|sole)\s+(?:(?:through|via|by|with)\s+)?(?:the\s+)?librarian\b" + stc._LIB_BOUND
    + r"|\blibrarian\s+(?:is|as|=|:)\s+(?:the\s+)?(?:only|sole)\b(?=(?:(?!\b(?:never|not|no|cannot)\b)[^\n.;!?])*"
      r"\b(?:writ|edit|chang|updat|modif|amend|rule|identity|authori|approv|lock)\w*)"
    + r"|\blibrarian\s+(?:alone|only)\s+(?:(?:can|may|shall|should|must|will)\s+(?:be\s+)?)?" + stc._LIB_WRITE,
    re.I)


def contested_sentence(sentence: str) -> bool:
    """True when `sentence` holds the contested #4 Librarian-authority claim (`_CONTESTED_BOUND`)."""
    return bool(_CONTESTED_SENTENCE.search(sentence) and _CONTESTED_BOUND.search(sentence))


# An item about the Booking / acting scope or a personal area (the hub's denied MASTER_IDENTITY sections:
# "roles that break his acting boundaries (MASTER_IDENTITY -> Acting)") is never copied.
_SETTLED_SCOPE_DENY = re.compile(r"booking|my-workspace|\b(?:acting|casting|auditions?|boundar\w*|family|health|contacts?|address\w*)\b", re.I)


def settled_items(text: str) -> List[str]:
    """The list items under a "NEVER" heading of an AGENTS_NEVER text (raw, whitespace folded)."""
    out: List[str] = []
    on = False
    for line in (text or "").split("\n"):
        h = _SETTLED_HEAD.match(line)
        if h:
            on = bool(re.match(r"never\b", h.group(1).strip(), re.I))
            continue
        m = _SETTLED_ITEM.match(line) if on else None
        if m:
            out.append(re.sub(r"\s+", " ", m.group(1)).strip())
    return out


def settled_bullets(items: Sequence[str], policy: Optional[stc.Policy] = None) -> List[str]:
    """The host's compact Guardrails bullets (text, no marker) for the settled items, capped."""
    policy = policy or stc.default_policy()
    out: List[str] = []
    size = 0
    for it in items or ():
        if _SETTLED_SCOPE_DENY.search(it):
            continue  # Booking / acting / personal scope: never a Memory Scrolls guardrail
        keep = [s for s in (x.strip() for x in _SETTLED_SPLIT.split(it)) if s and policy.match(s) is None and not _CONTESTED_SENTENCE.search(s)]
        if not keep or not re.match(r"never\b", keep[0], re.I) or len(keep[0]) > SETTLED_MAX_FIRST:
            continue
        text = keep[0]
        for s in keep[1:]:
            if len(text) + 1 + len(s) > SETTLED_MAX_ITEM:
                break
            text = f"{text} {s}"
        new, act = approver_fix(text)
        if act == "demote":
            continue
        text = new if act == "rewrite" else text
        if len(out) >= SETTLED_MAX_BULLETS or size + len(text) + 3 > SETTLED_MAX_BYTES:
            break
        out.append(text)
        size += len(text) + 3
    return out


def _covers(rule: str, text: str) -> bool:
    """True when bullet `text` states settled `rule`: its modal families (a NEVER rule needs a negated
    bullet), >= 50 % of the words of its NEVER sentence and >= 40 % of all its words, its head verb."""
    first = _SETTLED_SPLIT.split(rule, 1)[0]
    rf, ra, bw = _swords(first, True), _swords(rule, True), _swords(text, True)
    h = _head(_sup_text(first, True))
    if not rf or not ra or (h and h not in bw) or not _families(_sup_text(first, True)) <= _families(_sup_text(text, True)):
        return False
    return len(rf & bw) / len(rf) >= 0.5 and len(ra & bw) / len(ra) >= 0.4


def settled_body(t: sc.Target, body: str, cur_body: str = "", idx: Optional[PlanIndex] = None, policy: Optional[stc.Policy] = None) -> Tuple[str, Counter]:
    """(body, counts): the settled guardrails present as standalone ## Guardrails bullets."""
    if idx is None or not idx.settled or t.kind != "architecture":
        return body, Counter()
    rows, keep = _new_rows(body, cur_body)
    if GUARDRAILS not in [r[2].split(None, 1)[1].strip() for r in rows if r[1] == 2]:
        return body, Counter()
    have = [(i, sec, line) for i, (sec, lvl, line) in enumerate(rows) if lvl == 0 and sec not in (None, sc.SUPERSEDED) and sc._BULLET.match(line)]
    replace: Dict[int, str] = {}
    placed: List[str] = []  # added or replacing a Guardrails bullet: written in source order
    used: set = set()
    for rule in settled_bullets(idx.settled, policy):
        if any(sc.norm(line) == sc.norm(rule) for _, _, line in have):
            continue
        cover = None
        for i, sec, line in have:
            if i in used:
                continue
            found, rest = _marks(_split_bullet(line)[1])
            if not found and _covers(rule, rest):
                cover = (i, sec, line)
                break
        if cover is not None:
            i, sec, line = cover
            used.add(i)
            # Round 9: the host copy is always written under ## Guardrails. A NEW Guardrails bullet
            # it covers is replaced only when the host text holds (nearly) all of its words (an extra
            # clause is never dropped); a bullet elsewhere, or a current-scroll line, stays as it is
            # (a narrower or conditional restatement never stands for the settled rule).
            # v6: and only when it is a restatement (`settled_restatement`): "Never change config files"
            # covers "Never change rules or identity files" at 50 % but is a different guardrail.
            if (sec == GUARDRAILS and sc.norm(line) not in keep and _mostly_within(_swords(_marks(_split_bullet(line)[1])[1], True), _swords(rule, True))
                    and settled_restatement(rule, _marks(_split_bullet(line)[1])[1])):
                replace[i] = rule
        placed.append(rule)
    if not placed:
        return body, Counter()
    first = next((i for i, sec, _ in have if sec == GUARDRAILS), None)
    head = next(i for i, (sec, lvl, _) in enumerate(rows) if lvl == 2 and sec == GUARDRAILS)
    out: List[str] = []
    for i, (sec, lvl, line) in enumerate(rows):
        if i == first:
            out += [f"- {x}" for x in placed]
        if i in replace:
            continue
        out.append(line)
        if first is None and i == head:
            out += [f"- {x}" for x in placed] + [""]
    c: Counter = Counter()
    if replace:
        c["settled_replaced"] = len(replace)
    if len(placed) > len(replace):
        c["settled_added"] = len(placed) - len(replace)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)), c


# v6: restatements of a settled guardrail. Once the host copy is under ## Guardrails, a NEW unmarked model
# bullet anywhere in the scroll (a NEW locked bullet too; a current-scroll line never) that says the same
# thing goes: the same polarity (the rule's NEVER family, no modal family the rule lacks), its head verb,
# 2 or more of its words and at least 60 % of its NEVER sentence's or of all its words, and at most a fifth
# of the bullet's words outside the rule (a genuinely extra clause or another object keeps it). A restatement that ADDS an exception or condition the rule does
# not have ("without (explicit) approval", "unless ...", "only with / after ...", "except ...") always goes
# (it weakens an absolute rule): then the head verb and 2 of the rule's words (the exception cut) suffice. An "(unconfirmed)" bullet made only of a settled half and a contested #4
# sentence goes when another "(unconfirmed)" bullet of the scroll still carries a contested sentence.
_EXCEPTION = re.compile(
    r"\b(?:without\s+(?:(?:prior|explicit|express|written|clear|nic['’]s|his|the\s+user['’]s|the\s+operator['’]s|an?|any)\s+)*"
    r"(?:approval|permission|consent|sign-?off|go-?ahead|confirmation|ok)\b"
    r"|unless\b[^.;]*|except\b[^.;]*|only\s+(?:with|after|when|if|once|upon|via|through)\b[^.;]*"
    r"|(?:until|before)\s+(?:nic|the\s+user|the\s+operator|someone|an?\s+\w+)\s+(?:approves|confirms|says|oks)\b[^.;]*)",
    re.I)
_ANY_SENT = re.compile(r"[.;!?]+(?:\s+|$)")
# A drive / %VAR% / home path or a relative path with a separator (round 10, `settled_restatement`).
# Not a slash list ("skills/MCPs/packages"): a forward-slash path needs a file extension or a final "/".
_RESTATE_PATH = re.compile(r"(?<![\w.])(?:[A-Za-z]:[\\/]|%[A-Za-z_]+%|~[\\/])[^\s,;)]*|(?<![\w.])[\w.-]+\\[^\s,;)]*"
                           r"|(?<![\w.])[\w.-]*(?:/[\w.-]+)*/[\w-]+\.[A-Za-z]\w{0,5}\b|(?<![\w./])[\w.-]+(?:/[\w.-]+)*/(?=[\s,;)]|$)")


def _exception_kinds(text: str) -> set:
    return {m.group(0).split()[0].lower() for m in _EXCEPTION.finditer(_sup_text(text, True))}


def _extra_paths(text: str, other: str) -> bool:
    """True when `text` names a path / drive (`_RESTATE_PATH`) that `other` does not (round 10)."""
    def paths(x: str) -> set:
        return {m.lower().rstrip(".:") for m in _RESTATE_PATH.findall(_sup_text(x, True))}
    return bool(paths(text) - paths(other))


def settled_restatement(rule: str, text: str) -> bool:
    """True when bullet `text` (marks off) restates settled `rule` (see above); an added exception counts."""
    rest = _sup_text(text, True)
    added = _exception_kinds(rest) - _exception_kinds(rule)
    core = _EXCEPTION.sub(" ", rest) if added else rest
    first = _sup_text(_SETTLED_SPLIT.split(rule, 1)[0], True)
    rf, ra, bw = _swords(first), _swords(_sup_text(rule, True)), _swords(core)
    h = _head(first)
    if not rf or not bw or (h and h not in bw):
        return False
    # "always X" restates an imperative sentence of the rule ("... Label assumptions."): "must" is allowed.
    if not (_families(first) <= _families(core) <= _families(_sup_text(rule, True)) | {"must"}):
        return False
    # Round 10: a path / drive the rule does not name ("models live on D:\models") is an extra fact.
    if _extra_paths(core, rule):
        return False
    if added:  # an exception on (part of) the rule: any restatement of it weakens it ...
        # ... round 10: but only of the rule's own object: the cut core adds at most a fifth of words
        # ("Never change MCP config files without ..." is another guardrail; so is "... emails to clients").
        return len(bw & ra) >= min(2, len(bw)) and len(bw - ra) <= len(bw) // 5
    hit_f, hit_a = len(bw & rf), len(bw & ra)
    return hit_a >= 2 and max(hit_f / len(rf), hit_a / len(ra)) >= 0.6 and len(bw - ra) <= len(bw) // 5


def _contested_half(text: str) -> Tuple[List[str], List[str]]:
    """(contested #4 sentences, the other sentences) of a bullet's text (marks off)."""
    sents = [s for s in _ANY_SENT.split(_sup_text(text, True)) if s.strip()]
    return [s for s in sents if contested_sentence(s)], [s for s in sents if not contested_sentence(s)]


def settled_restatements_body(t: sc.Target, body: str, cur_body: str = "", idx: Optional[PlanIndex] = None,
                              policy: Optional[stc.Policy] = None) -> Tuple[str, Counter]:
    """(body, counts): NEW restatements of a settled guardrail present under ## Guardrails are dropped."""
    if idx is None or not idx.settled or t.kind != "architecture":
        return body, Counter()
    rows, keep = _new_rows(body, cur_body)
    rules = settled_bullets(idx.settled, policy)
    host = {sc.norm(r) for r in rules}
    present = [r for r in rules if any(sec == GUARDRAILS and lvl == 0 and _split_norm(line) == sc.norm(r) for sec, lvl, line in rows)]
    if not present:
        return body, Counter()
    drop: set = set()
    contested_rows = set()
    for i, (sec, lvl, line) in enumerate(rows):
        if lvl == 0 and sec not in (None, sc.SUPERSEDED) and sc._BULLET.match(line):
            found, rest = _marks(_split_bullet(line)[1])
            if "unconfirmed" in found and _contested_half(rest)[0]:
                contested_rows.add(i)
    c: Counter = Counter()
    for i, (sec, lvl, line) in enumerate(rows):
        if lvl != 0 or sec in (None, sc.SUPERSEDED) or not sc._BULLET.match(line) or len(line) != len(line.lstrip()):
            continue
        if sc.norm(line) in keep or _split_norm(line) in host:
            continue
        found, rest = _marks(_split_bullet(line)[1])
        if not found:
            if any(settled_restatement(r, rest) for r in present):
                drop.add(i)
                c["settled_restatement_dropped"] += 1
            continue
        if found == {"unconfirmed"} and i in contested_rows and (contested_rows - drop - {i}):
            _con, other = _contested_half(rest)
            if other and any(settled_restatement(r, ". ".join(other)) for r in present):
                drop.add(i)
                c["settled_contested_dropped"] += 1
    if not drop:
        return body, Counter()
    return "\n".join(r[2] for i, r in enumerate(rows) if i not in drop), c


# (3) Rule / identity / prompt / config file edits: `rule_file_edit` (imperative_kind "rule_file_edit").

# (4) Safety-critical terms carry their limits: (name, term, every required qualifier, host qualifier).
# A NEW bullet (or KG observation) naming the term without them gets the host qualifier appended, or goes
# when that makes it longer than QUALIFIED_MAX. Sources: docs/TONY_STEERING_SPEC.md section 3
# (auto_dispatch), the offload docstring and MEMORY_TIERING_REPORT (--apply, un-embed).
QUALIFIERS: Tuple[Tuple[str, "re.Pattern[str]", Tuple[str, ...], str], ...] = (
    ("auto_dispatch", re.compile(r"\bauto[_ -]dispatch\b|\bskips?\b[^\n]{0,40}\btier[- ]?3\b", re.I),
     (r"\bbrainstorm", r"\bpipeline\b", r"\bstaging\b", r"\bapprove\(\)"),
     "(auto_dispatch: only in a live brainstorm with a pipeline target; writes go to staging/ only; approve() still gates every mutating plan)"),
    ("apply", re.compile(r"(?<![\w-])--apply\b"), (r"\bnic\b|--confirm\b",), "(--apply: Nic runs it, with --confirm <token> from the dry-run)"),
    ("unembed", re.compile(r"\bun-?embed", re.I), (r"\bworkspace", r"\bsnapshot|\barchiv"), "(un-embed: per workspace, only after a verified cold-archive snapshot)"),
    # v6: the Tier-3 gate stated as absolute ("Envelope created only after approved Tier-3 yes or ledger
    # Run click", "Tier-3 gates dispatch") has the Builder exception (TONY_STEERING_SPEC section 3).
    ("tier3_gate", re.compile(r"\bonly\s+after\b[^\n.;]{0,40}\btier[- ]?3\b|\btier[- ]?3\b[^\n.;]{0,30}\bgates?\s+(?:every\s+|all\s+)?dispatch", re.I),
     (r"\bauto[_ -]?dispatch\b",),
     "(except auto_dispatch in Builder: pipeline build from a live brainstorm, writes to staging/ only; approve() still gates every mutating plan)"),
)
QUALIFIED_MAX = 480


_FEATURE_OFF = re.compile(r"\b(?:off|disabled|unused|removed|dropped|turned\s+off|switched\s+off)\b", re.I)


def _qualifier_negated(term: "re.Pattern[str]", text: str) -> bool:
    """True when every sentence naming the term is negated or says the feature is off (round 9): the
    host qualifier there would turn "Never un-embed a workspace" into a conditional permission."""
    sents = [x for x in re.split(r"(?<=[.;!?])\s+", _sup_text(text)) if term.search(x)]
    return bool(sents) and all("neg" in _families(x) or _FEATURE_OFF.search(x) for x in sents)


def qualify(text: str) -> Tuple[Optional[str], str]:
    """(text + missing qualifiers, "append") / (None, "drop") / (None, "")."""
    if not isinstance(text, str):
        return None, ""
    new = text.rstrip()
    for _name, term, needs, q in QUALIFIERS:
        if term.search(new) and not all(re.search(n, new, re.I) for n in needs) and not _qualifier_negated(term, text):
            new = f"{new} {q}"
    if new == text.rstrip():
        return None, ""
    return (None, "drop") if len(new) > QUALIFIED_MAX else (new, "append")


def qualifier_body(t: sc.Target, body: str, cur_body: str = "") -> Tuple[str, Counter]:
    rows, keep = _new_rows(body, cur_body)

    def decide(sec, line):
        if sc.norm(line) in keep:
            return None
        new, act = qualify(line)
        if act == "drop":
            return ("drop", "qualifier")
        return ("edit", "qualifier", new) if act == "append" else None

    body, c = _relocate(t, rows, decide)
    return body, _renamed(c, "qualifier_edited", "qualifier_appended")


# (6) Unsupported rules: a NEW bullet stating a prohibition / obligation ("never", "do not", "no", "must",
# "always", "only") needs a source sentence of the batch with the same modal families, >= 2 of its
# content words (all of them when it has fewer) and its head word (the first content word after the
# modal). An obligation ("always X") is also supported by a source imperative that starts with its head
# ("X ..."). Bracketed text (host qualifiers and annotations, asides) is ignored. Otherwise the bullet is
# "(unverified)" and leaves the locked sections; under Lessons and Fixes it is dropped.
_FAMILIES = (
    ("neg", re.compile(r"\b(?:never|not|no|without|nothing|none|nobody|neither|nor|cannot)\b|\b\w+n['’]t\b|\b(?:dont|doesnt|wont|cant|isnt|arent|shouldnt|mustnt)\b", re.I)),
    ("must", re.compile(r"\b(?:must|always|required|shall|(?:have|has|need|needs)\s+to)\b", re.I)),
    ("only", re.compile(r"(?<![\w-])only\b(?!-)", re.I)),
)
_MODAL_WORDS = frozenset(
    "never not no without nothing none nobody neither nor cannot must always required shall only dont doesnt wont cant isnt arent shouldnt mustnt "
    "don doesn won can isn aren shouldn mustn didn wasn weren couldn wouldn hasn haven".split())
_SUP_STOP = frozenset(_PLAN_STOP | _MODAL_WORDS | frozenset("md etc the and then".split()))
_SUP_SENT = re.compile(r"[.;!?]+(?:\s+|$)")
_SUP_TOKEN = re.compile(r"[a-z0-9][a-z0-9_]*")


_NO_STEM = frozenset("anything something everything nothing thing things during".split())
# Irregular past forms (round 9): "Messages are never sent" restates "Never send ...".
_IRREGULAR = {
    "sent": "send", "written": "write", "wrote": "write", "made": "make", "chosen": "choose", "chose": "choose", "kept": "keep",
    "built": "build", "held": "hold", "taken": "take", "took": "take", "given": "give", "gave": "give", "shown": "show", "seen": "see",
    "found": "find", "broken": "break", "broke": "break", "paid": "pay", "told": "tell", "gotten": "get", "used": "use", "ran": "run",
    "frozen": "freeze", "froze": "freeze", "forgotten": "forget", "hidden": "hide", "spoken": "speak", "spoke": "speak", "driven": "drive",
    "drove": "drive", "begun": "begin", "began": "begin", "bought": "buy", "brought": "bring", "thought": "think", "sold": "sell",
}


def _sstem(w: str) -> str:
    if w in _NO_STEM:
        return w
    w = _IRREGULAR.get(w, w)
    if w.endswith("ies") and len(w) > 4:
        w = w[:-3] + "y"
    elif w.endswith(("sses", "xes", "zes", "ches", "shes")):
        w = w[:-2]
    elif w.endswith("s") and not w.endswith(("ss", "us", "is")) and len(w) > 3:
        w = w[:-1]
    if w.endswith("ing") and len(w) > 5:
        w = w[:-3]
    elif w.endswith("ed") and len(w) > 4:
        w = w[:-2]
    if w.endswith("e") and len(w) >= 4:  # store / stored / storing -> "stor" (round 9)
        w = w[:-1]
    if len(w) >= 4 and w[-1] == w[-2] and w[-1] not in "aeiouls":
        w = w[:-1]
    return w


def _sup_text(text: str, keep_brackets: bool = False) -> str:
    """Bullet / source text for the support check: marker and host marks off, bold off, bracketed
    asides off (kept with `keep_brackets`), backtick contents kept."""
    _, rest = _marks(_split_bullet(re.sub(r"^\s*\d+[.)]\s+", "- ", text or ""))[1])
    rest = rest.replace("**", " ").replace("`", " ")
    while not keep_brackets:  # innermost first: "(... approve() still gates ...)" goes whole
        new = re.sub(r"\([^()\n]*\)", " ", rest)
        if new == rest:
            break
        rest = new
    return rest


def _swords(text: str, prep: bool = False) -> set:
    t = _sup_text(text, keep_brackets=True) if prep else text
    return {_sstem(w) for w in _SUP_TOKEN.findall((t or "").lower()) if len(w) >= 3 and w not in _SUP_STOP}


def _first_word(sentence: str) -> Optional[str]:
    for w in _SUP_TOKEN.findall(sentence.lower()):
        if len(w) >= 3 and w not in _SUP_STOP:
            return _sstem(w)
    return None


def _head(sentence: str) -> Optional[str]:
    """The first content word after the sentence's first modal (else its first content word)."""
    hits = [m.start() for _, rx in _FAMILIES for m in [rx.search(sentence)] if m]
    if hits:
        h = _first_word(sentence[min(hits):])
        if h:
            return h
    return _first_word(sentence)


def _families(sentence: str) -> frozenset:
    return frozenset(f for f, rx in _FAMILIES if rx.search(sentence))


_SUP_ACTORS = frozenset({"nic", "user", "operator"})


def _sup_actors(sentence: str) -> set:
    """The human actors named before the sentence's first modal word (stemmed)."""
    hits = [m.start() for _, rx in _FAMILIES for m in [rx.search(sentence)] if m]
    pre = sentence[:min(hits)] if hits else ""
    return {_sstem(w) for w in _SUP_TOKEN.findall(pre.lower()) if w in _SUP_ACTORS}


def _bracket_parts(text: str) -> List[str]:
    """The contents of every "(...)" of `text`, innermost first, each without its own inner brackets."""
    out: List[str] = []
    rest = text
    while True:
        found = re.findall(r"\(([^()\n]*)\)", rest)
        if not found:
            return out
        out += [x for x in found if x.strip()]
        rest = re.sub(r"\([^()\n]*\)", " ", rest)


class SupportIndex:
    """Every sentence of a batch's source lines: (modal families, content words, first content word)."""

    def __init__(self, lines: Iterable[str] = ()):
        self.sents: List[Tuple[frozenset, set, Optional[str]]] = []
        for line in lines or ():
            text = _sup_text(line)
            parts = [s for s in _SUP_SENT.split(text) if s.strip()]
            # Each sentence, and the whole line when it has several (a bullet may merge two sentences
            # of one rule: "Never send anything. No emails or posts." -> "Never send emails or posts").
            # The whole line only when every sentence has the same modal families (round 9): a
            # "never" of one sentence never lends its negation to an affirmative one ("Never delete.
            # Move it to a review label." does not support "Never move files to a review label").
            # A run of consecutive sentences with the same (non-empty) families is merged.
            merged, run = [], []
            for s in parts + [""]:
                if run and (not s or _families(s) != _families(run[0])):
                    if len(run) > 1 and _families(run[0]):
                        merged.append(". ".join(run))
                    run = []
                if s:
                    run.append(s)
            # A rule stated in brackets of the source ("(offload_rules: ... are never chosen)") is
            # its own sentence (round 9); its polarity stays its own.
            inner = [s for b in _bracket_parts(_sup_text(line, keep_brackets=True)) for s in _SUP_SENT.split(b) if s.strip()]
            for s in parts + merged + inner:
                w = _swords(s)
                if w:
                    self.sents.append((_families(s), w, _first_word(s)))

    def supported(self, text: str) -> bool:
        """True when every modal sentence of `text` has a supporting source sentence."""
        for s in _SUP_SENT.split(_sup_text(text)):
            fam = _families(s)
            words = _swords(s)
            if not fam or not words:
                continue
            need = min(2, len(words))
            h = _head(s)
            # Round 9: a rule the bullet puts on Nic ("Nic never sends anything") needs a source
            # sentence that names him; the agents' "Never send anything" is not about him.
            actors = _sup_actors(s)
            ok = False
            for sf, sw, first in self.sents:
                if len(words & sw) < need or (h and h not in sw) or not actors <= sw:
                    continue
                missing = fam - sf
                # An obligation ("always X") on a source imperative ("X ..."): only when the source has
                # no modal family the bullet lacks (round 9: "Always commit model files" is never
                # supported by "Never commit model files", whose first content word is also "commit").
                if not missing or (missing == {"must"} and first == h and sf <= fam):
                    ok = True
                    break
            if not ok:
                return False
        return True


def support_body(t: sc.Target, body: str, cur_body: str = "", idx: Optional[PlanIndex] = None) -> Tuple[str, Counter]:
    """(body, counts): a NEW unmarked rule bullet with no supporting source sentence is "(unverified)"
    (moved out of a locked section), or dropped from Lessons and Fixes. Off without a support index."""
    sup = getattr(idx, "support", None) if idx is not None else None
    if sup is None:
        return body, Counter()
    rows, keep = _new_rows(body, cur_body)

    def decide(sec, line):
        if sc.norm(line) in keep or sec == OPEN_THREADS:
            return None
        found, _ = _marks(_split_bullet(line)[1])
        if found or sup.supported(line):
            return None
        if t.kind == "pattern":
            return ("drop", "unsupported")
        return ("demote", "unsupported", _add_mark(line, UNVERIFIED))

    return _relocate(t, rows, decide)


# (7) Storage paths that do not exist: `probe(token) -> True / False / None` (offload builds it: known
# roots only, read-only stat; the Memory Scrolls write targets that --apply creates answer None). Under
# Key Paths / Repo Paths every path token is checked, elsewhere storage files (.db / .sqlite / .json /
# .jsonl); a missing one is annotated "(planned, not created yet)" after its first mention (an existing
# annotation is never removed, so a file created later never makes a preview refuse).
PLANNED_NOT_CREATED = "(planned, not created yet)"
_PATH_TOK = re.compile(
    r"(?:%[A-Za-z_]+%|(?<![\w])[A-Za-z]:)[\\/][^\s`'\"()|,;]*"
    r"|(?<![\w.%\\/:<>{}*-])(?:[\w.-]+[\\/])+[\w.<>{}*-]*"
    r"|(?<![\w.\\/%-])[\w-]+\.(?:db|sqlite3?|json|jsonl)(?![\w-]|\.\w)"  # v6: never "modes.json" of "modes.json.bad"
)
_STORE_EXT = re.compile(r"\.(?:db|sqlite3?|json|jsonl)$", re.I)


def _probe(probe, token: str) -> Optional[bool]:
    try:
        return probe(token)
    except Exception:
        return None


_TICKS = re.compile(r"`([^`\n]+)`")
_PATHISH = re.compile(r"^(?:%[A-Za-z_]+%|[A-Za-z]:)[\\/]|[\\/]|\.(?:db|sqlite3?|json|jsonl)$", re.I)
_PATH_WORD = re.compile(r"[\\/]|^[A-Za-z]:")


def _path_tokens(text: str) -> List[Tuple[str, int]]:
    """(token, end) of every path mention: a whole `backtick` span that looks like a path (spaces
    allowed), else a regex token outside backticks. An unquoted path with spaces ("D:\\Art Apps\\x")
    cannot be delimited: its pieces are skipped (None from the probe would be a guess)."""
    out: List[Tuple[str, int]] = []
    masked = list(text)
    for m in _TICKS.finditer(text):
        inner = m.group(1).strip()
        if _PATHISH.search(inner):
            out.append((inner.rstrip(".,:;"), m.end()))
        for k in range(m.start(), m.end()):
            masked[k] = " "
    flat = "".join(masked)
    for m in _PATH_TOK.finditer(flat):
        tok = m.group(0).rstrip(".,:;")
        if not tok:
            continue
        before = flat[:m.start()]
        prev = before.split()[-1] if before.strip() and before.endswith(" ") else ""
        after = flat[m.start() + len(tok):]
        nxt = after.split()[0] if after.startswith(" ") and after.strip() else ""
        if (prev and _PATH_WORD.search(prev)) or (nxt and _PATH_WORD.search(nxt) and _PATH_WORD.search(tok)):
            continue
        out.append((tok, m.start() + len(tok)))
    return sorted(out, key=lambda x: x[1])


def annotate_paths(text: str, probe, any_path: bool) -> Optional[str]:
    """`text` with "(planned, not created yet)" after the first mention of each missing path, or None."""
    if not probe or not isinstance(text, str):
        return None
    inserts: List[int] = []
    seen: set = set()
    for tok, end in _path_tokens(text):
        if not tok or tok in seen:
            continue
        seen.add(tok)
        if not any_path and not _STORE_EXT.search(tok.rstrip("\\/")):
            continue
        if _probe(probe, tok) is not False:
            continue
        if text[end:].lstrip().startswith(PLANNED_NOT_CREATED):
            continue
        inserts.append(end)
    if not inserts:
        return None
    out = text
    for pos in sorted(set(inserts), reverse=True):
        out = f"{out[:pos]} {PLANNED_NOT_CREATED}{out[pos:]}"
    return out


def paths_body(t: sc.Target, body: str, cur_body: str = "", idx: Optional[PlanIndex] = None) -> Tuple[str, Counter]:
    probe = getattr(idx, "probe", None) if idx is not None else None
    if not probe:
        return body, Counter()
    rows, keep = _new_rows(body, cur_body)

    def decide(sec, line):
        if sc.norm(line) in keep:
            return None
        new = annotate_paths(line, probe, sec in PATH_SECTIONS)
        return ("edit", "path_planned", new) if new is not None else None

    body, c = _relocate(t, rows, decide)
    return body, _renamed(c, "path_planned_edited", "path_planned")


# (9) Hygiene: near-duplicate bullets of one section (the later NEW one goes; a settled host bullet
# stays), a count that no longer matches the list it introduces ("same 7" over 4 items: the number goes),
# and one-night measurements ("~80 KB", "41 rows ~100 KB", a "Disk footprint" label: those sentences go).
_NUM_WORDS = {"two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12}
_COUNT_TOKEN = re.compile(r"(?<![\w.:%/-])(\d{1,2}|" + "|".join(_NUM_WORDS) + r")(?![\w.:%/-])\s?", re.I)
_MEASURE = re.compile(r"~\s?\d+(?:\.\d+)?\s?(?:B|KB|KiB|MB|MiB|GB|GiB|bytes?|rows?|ms|s)\b", re.I)
_FOOTPRINT_LABEL = re.compile(r"^(?:disk\s+footprint|footprint|disk\s+usage|db\s+size|sizes?\s+measured)$", re.I)
_SIZE_NUMBER = re.compile(r"\b\d+(?:\.\d+)?\s?(?:KB|MB|GB|rows?)\b", re.I)
# A size in a rule, not a measurement: a cap, a limit, a threshold ("past 400 rows log only ...").
_SIZE_CAP = re.compile(r"≤|<=|≥|>=|\bcaps?\b|\bmax\w*\b|\blimit\w*|\bat most\b|\bpast\b|\bover\b|\babove\b|\bafter\b|\bonly\b|\bthreshold", re.I)


_NUMBERS = re.compile(r"\d+(?:\.\d+)*")


_NEG_PREFIX = re.compile(r"\b(un|non|dis|in)-(?=[a-z])", re.I)


def _dup_text(text: str) -> str:
    # "un-embedded" stays one word ("unembedd"), never "embedded" (round 9)
    return _NEG_PREFIX.sub(r"\1", _sup_text(text, keep_brackets=True))


def _dup_words(text: str) -> set:
    return _swords(_dup_text(text))


def _mostly_within(a: set, b: set) -> bool:
    """True when at most a fifth (at least one word) of `a` is missing from `b`."""
    return len(a - b) <= max(1, len(a) // 5)


def near_duplicate(a: str, b: str) -> bool:
    """Two bullets that say the same thing: the same text, or the same numbers (a port, a count, a
    version) and >= 80 % of the shorter one's words and >= 50 % of the longer one's (marks, markers and
    bold ignored). "Serves on port 1234" vs "... 1235" is a change, never a duplicate."""
    if sc.norm(_sup_text(a, True)) == sc.norm(_sup_text(b, True)):
        return True
    if set(_NUMBERS.findall(a)) != set(_NUMBERS.findall(b)):
        return False
    # The same polarity (round 9): "X" and "never X", "may edit" and "must not edit" are a
    # contradiction, never a duplicate (the modal words themselves are not content words).
    if _families(_dup_text(a)) != _families(_dup_text(b)):
        return False
    wa, wb = _dup_words(a), _dup_words(b)
    if min(len(wa), len(wb)) < 3:
        return False
    common = len(wa & wb)
    return common / min(len(wa), len(wb)) >= 0.8 and common / max(len(wa), len(wb)) >= 0.5


def _split_norm(line: str) -> str:
    return sc.norm(_split_bullet(line)[1])


def dedupe_body(t: sc.Target, body: str, cur_body: str = "", protect: Iterable[str] = ()) -> Tuple[str, Counter]:
    """(body, counts): of two near-duplicate top-level bullets of one section the later NEW one goes
    (the earlier one when the later is a current-scroll line or a settled host bullet)."""
    rows, keep = _new_rows(body, cur_body)
    prot = {sc.norm(x) for x in protect}
    drop: set = set()
    by_sec: Dict[str, List[int]] = {}
    for i, (sec, lvl, line) in enumerate(rows):
        if lvl == 0 and sec not in (None, sc.SUPERSEDED) and sc._BULLET.match(line) and len(line) == len(line.lstrip()):
            by_sec.setdefault(sec, []).append(i)
    for idxs in by_sec.values():
        for k, j in enumerate(idxs):
            if j in drop:
                continue
            for i in idxs[:k]:
                if i in drop or not near_duplicate(rows[i][2], rows[j][2]):
                    continue
                # Round 9: a bullet only goes when the other one holds (nearly) all its words, so a
                # restatement that adds a clause ("..., and never write to C:\ai-hub") stays.
                cand = [x for x in (j, i) if sc.norm(rows[x][2]) not in keep and _split_norm(rows[x][2]) not in prot
                        and _mostly_within(_dup_words(rows[x][2]), _dup_words(rows[i if x == j else j][2]))
                        and not _extra_paths(rows[x][2], rows[i if x == j else j][2])]
                if cand:
                    drop.add(cand[0])
                break
    if not drop:
        return body, Counter()
    return "\n".join(r[2] for i, r in enumerate(rows) if i not in drop), Counter({"duplicate_dropped": len(drop)})


def _children(rows, i: int) -> int:
    ind = len(rows[i][2]) - len(rows[i][2].lstrip())
    n = 0
    for _sec, lvl, line in rows[i + 1:]:
        if lvl or not line.strip():
            break
        li = len(line) - len(line.lstrip())
        if li <= ind:
            break
        if sc._BULLET.match(line):
            n += 1
    return n


def _num(tok: str) -> int:
    return int(tok) if tok.isdigit() else _NUM_WORDS[tok.lower()]


# Round 9: a number after an ordinal word ("Phase 5", "round 8", "tier 3", "v2") or after a name
# ("React 19", "Python 3") is a version / ordinal, never a count claim.
_ORDINAL_WORDS = frozenset(
    "phase phases tier tiers round rounds step steps stage stages version versions ver v level levels layer layers section sections part parts "
    "chapter chapters day days week weeks month months year years gen generation pass passes wave waves sprint sprints milestone milestones "
    "option options rule rules item items no number num port ports wave release build patch run runs iteration iterations attempt attempts "
    "f e r p q task tasks issue issues ticket pr book season episode act scene page pages figure table appendix room floor".split())
_COUNT_LEAD_WORDS = frozenset(
    "same the all only exactly about around approx approximately over under just these those its our their total both with has have uses "
    "runs lists holds keeps now still of and or in on at for to by from into across another other".split())


def _ordinal_number(head: str, m: "re.Match[str]") -> bool:
    before = head[:m.start()].rstrip()
    if not before or before[-1] in "#":
        return bool(before)
    w = re.findall(r"[A-Za-z][\w-]*", before[-40:])
    if not w or not re.search(r"[A-Za-z][\w-]*$", before):
        return False
    prev = w[-1]
    return prev.lower() in _ORDINAL_WORDS or (prev[0].isupper() and prev.lower() not in _COUNT_LEAD_WORDS)


def count_fix(line: str, listed: int) -> Optional[str]:
    """`line` (a bullet introducing `listed` sub-items with ':') without the one count that disagrees, or None."""
    lead, rest = _split_bullet(line)
    if listed < 1 or not rest.rstrip().endswith(":"):
        return None
    head = rest.rstrip()[:-1]
    bad = [m for m in _COUNT_TOKEN.finditer(head) if _num(m.group(1)) != listed and not _ordinal_number(head, m)]
    if len(bad) != 1:
        return None
    m = bad[0]
    new = re.sub(r"\(\s+", "(", re.sub(r"\s{2,}", " ", head[:m.start()] + head[m.end():])).rstrip()
    return f"{lead}{new}:"


def measure_fix(line: str) -> Tuple[Optional[str], bool]:
    """(line without its one-night measurement sentences, drop the whole bullet?)."""
    lead, rest = _split_bullet(line)
    label = ""
    b = _BOLD_LABEL.match(rest)
    if b:
        label, rest = b.group(1).strip().rstrip(":"), rest[b.end():]
    foot = bool(label) and bool(_FOOTPRINT_LABEL.match(label))
    parts = [p for p in re.split(r"(?<=[.;])\s+", rest.strip()) if p.strip()]

    def measured(p: str) -> bool:
        return bool(_MEASURE.search(p)) or (foot and bool(_SIZE_NUMBER.search(p)) and not _SIZE_CAP.search(p))

    kept = [p for p in parts if not measured(p)]
    if len(kept) == len(parts) and not foot:
        return None, False
    if not kept:
        return None, True
    text = re.sub(r";$", ".", " ".join(kept).strip())
    if label and not foot:
        text = f"**{label}:** {text}"
    new = f"{lead}{text}"
    return (new if new != line else None), False


def hygiene_body(t: sc.Target, body: str, cur_body: str = "") -> Tuple[str, Counter]:
    """(body, counts): NEW bullets lose one-night measurements and counts that disagree with their list."""
    rows, keep = _new_rows(body, cur_body)
    out, c = [], Counter()
    for i, (sec, lvl, line) in enumerate(rows):
        if lvl or not line.strip() or sec in (None, sc.SUPERSEDED) or not sc._BULLET.match(line) or sc.norm(line) in keep:
            out.append(line)
            continue
        new, gone = measure_fix(line)
        if gone:
            c["measurement_dropped"] += 1
            continue
        if new is not None:
            c["measurement_removed"] += 1
            line = new
        fixed = count_fix(line, _children(rows, i))
        if fixed is not None:
            c["count_claim_fixed"] += 1
            line = fixed
        out.append(line)
    return ("\n".join(out), c) if c else (body, c)


def content_body(t: sc.Target, body: str, cur_body: str = "", idx: Optional[PlanIndex] = None, new_scroll: bool = False,
                 policy: Optional[stc.Policy] = None) -> Tuple[str, Counter]:
    """Every body guard in its fixed order: Superseded hygiene, transient status / Key Paths,
    imperatives (incl. rule-file edits), plans (v3); approver, measurements / counts, rule support,
    qualifiers, settled guardrails, near-duplicates, storage paths (v5). Returns (body, counts by kind)."""
    c: Counter = Counter()
    body, n = superseded_body(body, cur_body, new_scroll)
    c.update({f"superseded_{k}": v for k, v in n.items()})
    protect = settled_bullets(idx.settled, policy) if idx is not None and idx.settled and t.kind == "architecture" else []
    for fn in (lambda b: status_paths_body(t, b, cur_body), lambda b: imperatives_body(t, b, cur_body, idx), lambda b: plans_body(t, b, cur_body, idx),
               lambda b: approver_body(t, b, cur_body), lambda b: hygiene_body(t, b, cur_body), lambda b: support_body(t, b, cur_body, idx),
               lambda b: qualifier_body(t, b, cur_body), lambda b: settled_body(t, b, cur_body, idx, policy),
               lambda b: settled_restatements_body(t, b, cur_body, idx, policy), lambda b: dedupe_body(t, b, cur_body, protect), lambda b: paths_body(t, b, cur_body, idx)):
        body, n = fn(body)
        c.update(n)
    return body, c


# ── tallies (rule ids / kinds and counts only) ──────────────────────────────

TALLY_KEYS = ("stale_source", "stale_current", "stale_output", "stale_demoted", "schema_source", "schema_output", "identity", "kg_merged", "content")


def new_tally() -> Dict[str, Counter]:
    return {k: Counter() for k in TALLY_KEYS}


def add_tally(into: Dict[str, Counter], other: Optional[Dict[str, Counter]]) -> None:
    for k, c in (other or {}).items():
        into.setdefault(k, Counter()).update(c)


def tally_json(t: Optional[Dict[str, Counter]]) -> Dict[str, Dict[str, int]]:
    return {k: {x: int(n) for x, n in sorted(c.items()) if n} for k, c in (t or {}).items() if c and sum(c.values())}


def tally_count(t: Optional[Dict[str, Counter]], *keys: str) -> int:
    return sum(sum((t or {}).get(k, Counter()).values()) for k in (keys or TALLY_KEYS))


# ── preview re-check (apply) ────────────────────────────────────────────────


def check_preview(t: sc.Target, body: str, entities: Sequence[dict], old_body: str = "", policy: Optional[stc.Policy] = None,
                  plans: Optional[PlanIndex] = None, new_scroll: Optional[bool] = None) -> Counter:
    """What the guards would still change in a preview (kinds and counts): `--apply` refuses a
    preview that is not a fixed point (made before the guards, or edited after its token).
    `plans`: the batch's PlanIndex (re-read from the hub at apply); `new_scroll` (default: no
    `old_body`): the target has no prior version."""
    policy = policy or stc.default_policy()
    new_scroll = (not old_body) if new_scroll is None else new_scroll
    c: Counter = Counter()
    _, n = content_body(t, body, old_body, plans, new_scroll, policy)
    for k, v in n.items():
        c[f"content_{k}"] += v
    _, n = content_entities(entities, plans)
    for k, v in n.items():
        c[f"content_{k}"] += v
    _, dropped, demoted, _ = stale_body(t, body, old_body, policy)
    if dropped:
        c["stale_claims"] += sum(dropped.values())
    if demoted:
        c["stale_demote"] += sum(demoted.values())
    _, n = strip_schema_body(body, old_body)
    if n:
        c["schema_echo"] += n
    _, n = identity_body(body, old_body)
    if n:
        c["user_relabel"] += n
    ents, ci = identity_entities(entities)
    c.update(ci)
    _, d2, m2 = stale_entities(ents, policy)
    if d2 or m2:
        c["stale_kg"] += sum(d2.values()) + sum(m2.values())
    _, n = strip_schema_observations(ents)
    if n:
        c["schema_kg"] += n
    return c
