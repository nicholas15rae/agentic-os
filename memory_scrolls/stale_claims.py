"""Stale-claims policy: deterministic removal of claims the baseline report marks stale or contested.

The brain/ and ai-hub sources still state facts that are no longer true (Linux/WSL as the platform,
Gemini CLI in the legacy 3-agent roster, retired cloud models, a CloudMart project, the old
C:\\ai-hub knowledge-graph path, a "default mutating" forwarding rule, the legacy free-tier account
list and runtime lines). A model distilling those sources brings them back as current truth, so the
host filters them deterministically, before AND after the model:

- source lines matching a `drop` rule never reach the model (`filter_text`);
- every output bullet and KG observation matching a `drop` rule is removed, and one matching a
  `demote` rule (contested until Nic confirms) leaves the locked sections, kept unlocked with an
  "(unconfirmed)" prefix (`guards.stale_output`);
- an EXISTING scroll's bullet is only touched when its rule says `existing: true`; a removed locked
  bullet is logged under ## Superseded Decisions with the rule's reason (never a silent loss).

Defaults are built in (repo-tracked, no personal values: product names, paths and generic phrases).
Nic can override them per machine with `<state_dir>/stale-claims.json` (only ever read):

    {"add": [{"id": "my-rule", "pattern": "regex", "action": "drop", "reason": "why", "ref": "#n",
              "existing": false, "negatable": false}],
     "remove": ["contested-escalation-ladder"]}

`python -m memory_scrolls status --show-stale-claims` prints the effective policy (default patterns
in full; an override pattern only as a hash). A preview records the policy version and hash in its
manifest and `--apply` refuses a preview made under another one.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

# Bump when a default rule changes what the filter removes: a preview records it.
# v2: negation-aware platform-linux / mutating-default ("no WSL", "non-mutating", "never forward" are kept).
# v3: contested #4 widened to its variants ("changes only through the Librarian", "only the Librarian
# edits rules / identity"; "read-only" is not its "only"); contested #6 ("ai-hub is the single
# source of truth", unscoped) is demoted.
# v4: contested #4 also as "<change / edit / write verb> ...; only (the) Librarian ..." in one sentence
# ("Never change rules or identity files; only Librarian with Nic's approval"); never "read-only Librarian".
STALE_CLAIMS_VERSION = 4
OVERRIDE_FILE = "stale-claims.json"
ACTIONS = ("drop", "demote")
UNCONFIRMED = "(unconfirmed)"
MAX_RULES = 64
MAX_PATTERN = 400
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")


@dataclass(frozen=True)
class Rule:
    id: str
    pattern: str
    action: str  # drop | demote
    reason: str
    ref: str = ""
    existing: bool = False  # also applies to bullets of an existing scroll
    source: str = "default"
    # A match right after a negation in the same clause ("no WSL", "never the Linux machine", "not a
    # Linux environment", "non-mutating") states the opposite of the stale claim: it does not count.
    negatable: bool = False

    @property
    def rx(self) -> "re.Pattern[str]":
        return _compile(self.pattern)

    def hits(self, text: str) -> bool:
        """True when the pattern is in `text` (for a negatable rule: at least once not negated)."""
        if not text:
            return False
        if not self.negatable:
            return bool(self.rx.search(text))
        return any(not _negated(text, m.start()) for m in self.rx.finditer(text))


_CACHE: Dict[str, "re.Pattern[str]"] = {}

_NEGATION = re.compile(
    r"\b(?:no|not|never|without|avoid\w*|nor|non|instead of|rather than|except|no longer|replac\w*|deprecated|retired|legacy|former(?:ly)?"
    r"|old|dropped|removed|dont|cant|wont|isnt|arent|doesnt|didnt)\b|\b\w+n['\u2019]t\b",
    re.I,
)
_CLAUSE_END = re.compile(r"[;.!?\n(,]")


def _negated(text: str, start: int) -> bool:
    """True when one of the (at most) 3 words before `start`, in the same clause, is a negation."""
    pre = text[:start]
    ends = [m.end() for m in _CLAUSE_END.finditer(pre)]
    if ends:
        pre = pre[ends[-1]:]
    return bool(_NEGATION.search(" ".join(pre.split()[-3:])))


def _compile(p: str) -> "re.Pattern[str]":
    rx = _CACHE.get(p)
    if rx is None:
        rx = re.compile(p, re.I)
        _CACHE[p] = rx
    return rx


# #4 helpers (round 10). Between "only / sole" and the write verb: no sentence end and no negation
# ("the Librarian only reads; it never writes" is the AOS read-only rule, not #4).
_NO_NEG_30 = r"(?:(?!\b(?:never|not|no|cannot)\b|n't\b)[^\n.;!?]){0,30}"
_LIB_WRITE = r"(?:chang|edit|writ|updat|modif|amend|rewrit|approv|lock)\w*"
# After "... only (the) Librarian": the clause ends, its approval follows, or a write verb (a modal
# allowed). "... and only the Librarian reads the hub" binds another verb to the Librarian: not #4.
_LIB_BOUND = (r"(?!['\u2019]s\b)(?=\s*(?:$|[,;:.!?)\u2013\u2014-]|with\b|and\s+nic\b"
              r"|(?:can|may|shall|should|must|will)(?:\s+(?:only\s+)?(?:be\s+)?" + _LIB_WRITE + r"|\s*(?:$|[,;:.!?]))|" + _LIB_WRITE + r"))")


# Conflict refs are the numbered rows of docs/AI_HUB_BASELINE_REPORT.md section 8.
DEFAULT_RULES: Tuple[Rule, ...] = (
    Rule("platform-linux",
         r"\b(?:ubuntu|wsl2?)\b|\blinux (?:environment|host|machine|desktop|box|only)\b"
         r"|\b(?:platform|operating system|os|environment|host)\s*(?:[:=]|is|runs on|on)\s*(?:a\s+)?linux\b",
         "drop", "Linux/WSL is not the platform; the host runs Windows 11", "#8", True, negatable=True),
    Rule("legacy-agent-roster",
         r"\bgemini[ -]cli\b[^\n]{0,60}\b(?:opencode|hermes)\b|\b(?:opencode|hermes)\b[^\n]{0,60}\bgemini[ -]cli\b"
         r"|\b(?:3|three)[- ]agents?\b[^\n]{0,60}\b(?:opencode|hermes|gemini|agy)\b|\bopencode\b[^\n]{0,40}\bhermes\b|\bhermes\b[^\n]{0,40}\bopencode\b"
         r"|\bgemini[ -]cli\b[^\n]{0,30}\b(?:is|as) (?:an? |the )?(?:active |current )?agent\b|\bagents?\s*[:=][^\n]{0,40}\bgemini[ -]cli\b",
         "drop", "the legacy opencode/Hermes/Gemini CLI roster is not current; the live roster is the Command Center one", "#1/#3", True),
    Rule("stale-model",
         r"\bowl[ -]alpha\b|\bdeepseek[- ]v4[- ]flash\S*",
         "drop", "retired cloud models; the current model is local Qwen 3.5 9B on LM Studio :1235", "#7", True),
    Rule("cloudmart-project",
         r"\bcloud ?mart\b",
         "drop", "CloudMart is not a confirmed active project", "#10", True),
    Rule("hub-kg-path",
         r"\bai-hub[\\/]+memory[\\/]+knowledge-graph(?:\.json)?\b",
         "drop", "the knowledge graph moved to the configured D: memory root; that hub file does not exist", "#15", True),
    # Only the positive shapes ("Mutating: true", "mutating by default", "default mutating", "mutating
    # ... forwards"): "non-mutating", "mutating is false by default", "mutating actions never forward"
    # and "mutating ... forward only after confirmation" restate never-send and are kept.
    Rule("mutating-default",
         r"(?<!non-)(?<!non )\bmutating\b\s*(?:[:=]|is|defaults? to|set to)\s*(?:true|yes|on|enabled)\b"
         r"|(?<!non-)(?<!non )\bmutating\b(?:(?!\b(?:false|no|not|never|off|non)\b)[^\n.;]){0,15}\bby default\b"
         r"|\bdefault\w*\b\s*(?:[:=]|is|to|as)?\s*(?:a\s+)?mutat\w*"
         r"|(?<!non-)(?<!non )\bmutat\w*\b(?:(?!\b(?:never|not|no|without|cannot|false|off)\b|\w+n't\b)[^\n.;]){0,40}\bforward\w*\b"
         r"(?![^\n.;]{0,40}\b(?:confirm\w*|approv\w*|read-?back)\b)",
         "drop", "a mutating-by-default / message-forwarding rule conflicts with never-send", "#22", True, negatable=True),
    Rule("legacy-free-tier-list",
         r"\bstudent (?:developer )?pack\b|\bgcp free(?: tier)?\b[^\n]{0,80}\b(?:colab|kaggle)\b|\b(?:colab|kaggle)\b[^\n]{0,20}\b(?:colab|kaggle)\b",
         "drop", "legacy free-tier account list; the scrolls keep only free-tier first", "#9", True),
    Rule("legacy-runtime",
         r"\bhermes\b[^\n]{0,40}\b(?:python|node(?:\.js)?)\b|\b(?:python|node(?:\.js)?)\s*[\d.]+\+?\s*\((?:fastapi|opencode|hermes)\)"
         r"|\bfastapi dashboard\b",
         "drop", "legacy runtime lines of the old Hermes/opencode/FastAPI stack", "#9", True),
    # #4 and its variants: "the Librarian is the only writer", "only the Librarian edits / changes
    # rules or identity", "changes (to identity) only through the Librarian". "read-only" is never
    # the "only" of this claim ("the Librarian is read-only; it never writes" is the AOS rule).
    Rule("contested-librarian-sole-writer",
         r"\blibrarian\b[^\n.;!?]{0,40}(?<!read-)(?<!read )\b(?:only|sole)\b" + _NO_NEG_30 + r"\b(?:writes?|writers?|writing|edits?|editor|changes?|updates?|modif\w*)\b"
         r"|(?<!read-)(?<!read )\b(?:only|sole)\b[^\n.;!?]{0,25}\blibrarian\b" + _NO_NEG_30 + r"\b(?:writes?|writers?|writing|edits?|editor|changes?|updates?|modif\w*)\b"
         r"|\b(?:changes?|edits?|updates?|writes?|modif\w*)\b[^\n]{0,40}\bonly\b[^\n]{0,12}\b(?:through|via|by)\b[^\n]{0,8}\blibrarian\b"
         r"|\bonly\s+(?:through|via|by)\s+(?:the\s+)?librarian\b"
         r"|\b(?:chang\w*|edit\w*|writ\w*|updat\w*|modif\w*|amend\w*|rewrit\w*)\b[^\n.!?]{0,60}(?<!read-)(?<!read )(?<!not )\bonly\s+(?:the\s+)?librarian\b" + _LIB_BOUND,
         "demote", "contested until Nic confirms (scope: ai-hub rule files?)", "#4", True),
    # #6: the hub as the single source of truth with no scope; the baseline resolves it as scoped
    # (the hub for operator, rules and hub layout; the aos AGENTS.md for the codebase). A line that
    # names its scope ("... for operator rules", "(rules, identity)") is kept; "for everything" is no scope.
    Rule("contested-hub-single-source",
         r"\b(?:ai[- ]?hub|hub)\b[^\n]{0,40}\b(?:single|one|only)\s+source\s+of\s+truth\b(?![^\n]{0,8}(?:\bfor\b(?!\s+(?:everything|all|anything)\b)|\((?!\s*(?:everything|all|anything)\b)))"
         r"|\b(?:single|one|only)\s+source\s+of\s+truth\b\s*(?:[:=]|is|=>|->|→)\s*(?:the\s+)?(?:[a-z]:[\\/]+)?(?:ai[- ]?hub|hub)\b(?![^\n]{0,8}(?:\bfor\b(?!\s+(?:everything|all|anything)\b)|\((?!\s*(?:everything|all|anything)\b)))",
         "demote", "contested until Nic confirms (scoped: the hub for operator, rules and hub layout; aos AGENTS.md for the codebase)", "#6", True),
    Rule("contested-escalation-ladder",
         r"\blocal\b[^\n]{0,40}(?:->|\u2192|=>|\bthen\b|>)[^\n]{0,30}\bgemini\b[^\n]{0,60}(?:->|\u2192|=>|\bthen\b|>)[^\n]{0,30}\bclaude\b"
         r"|\bescalat\w*\b[^\n]{0,60}\bgemini\b",
         "demote", "contested until Nic confirms (hub escalation ladder vs AOS routing)", "#5", True),
)


@dataclass(frozen=True)
class Policy:
    version: int
    rules: Tuple[Rule, ...]
    override_path: Optional[str] = None
    override_present: bool = False
    warnings: Tuple[str, ...] = ()

    @property
    def sha(self) -> str:
        blob = json.dumps({"v": self.version, "rules": [[r.id, r.pattern, r.action, bool(r.existing), bool(r.negatable)] for r in self.rules]}, sort_keys=True)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]

    def drop_rules(self) -> Tuple[Rule, ...]:
        return tuple(r for r in self.rules if r.action == "drop")

    def demote_rules(self) -> Tuple[Rule, ...]:
        return tuple(r for r in self.rules if r.action == "demote")

    def match(self, text: str, action: Optional[str] = None) -> Optional[Rule]:
        """The first rule (drop rules first) whose pattern is in `text`, else None."""
        if not text:
            return None
        for r in self.drop_rules() + self.demote_rules():
            if action and r.action != action:
                continue
            if r.hits(text):
                return r
        return None


def default_policy() -> Policy:
    return Policy(STALE_CLAIMS_VERSION, DEFAULT_RULES)


def override_path(state_dir) -> Path:
    return Path(state_dir) / OVERRIDE_FILE


def _clean(v, n: int) -> str:
    return re.sub(r"\s+", " ", v).strip()[:n] if isinstance(v, str) else ""


def load(state_dir) -> Policy:
    """Defaults, then `<state_dir>/stale-claims.json` when present. A bad entry is reported (by
    count / id, never by pattern) and ignored; a bad file leaves the defaults in force."""
    base = default_policy()
    path = override_path(state_dir)
    if not path.is_file():
        return dataclasses.replace(base, override_path=str(path))
    warnings: List[str] = []
    rules = list(base.rules)
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        data = None
        warnings.append("stale-claims override unreadable (not JSON): defaults used")
    if data is not None and not isinstance(data, dict):
        warnings.append("stale-claims override is not a JSON object: defaults used")
        data = None
    if isinstance(data, dict):
        extra = [k for k in data if k not in ("add", "remove")]
        if extra:
            warnings.append(f"stale-claims override: {len(extra)} unknown key(s) ignored")
        remove = data.get("remove") or []
        if not isinstance(remove, list):
            warnings.append("stale-claims override: remove is not a list; ignored")
            remove = []
        ids = {r.id for r in rules}
        unknown = [x for x in remove if not (isinstance(x, str) and x in ids)]
        if unknown:
            warnings.append(f"stale-claims override: {len(unknown)} unknown remove id(s) ignored")
        rules = [r for r in rules if r.id not in set(x for x in remove if isinstance(x, str))]
        add = data.get("add") or []
        if not isinstance(add, list):
            warnings.append("stale-claims override: add is not a list; ignored")
            add = []
        bad = 0
        for x in add[:MAX_RULES]:
            if not isinstance(x, dict):
                bad += 1
                continue
            rid, pat, act = _clean(x.get("id"), 48).lower(), x.get("pattern"), _clean(x.get("action"), 10).lower()
            if not _ID_RE.match(rid) or act not in ACTIONS or not isinstance(pat, str) or not 2 <= len(pat) <= MAX_PATTERN or rid in {r.id for r in rules}:
                bad += 1
                continue
            try:
                _compile(pat)
            except re.error:
                bad += 1
                continue
            rules.append(Rule(rid, pat, act, _clean(x.get("reason"), 160) or "override", _clean(x.get("ref"), 20), bool(x.get("existing")), "override",
                              x.get("negatable") is True))
        if bad or len(add) > MAX_RULES:
            warnings.append(f"stale-claims override: {bad + max(0, len(add) - MAX_RULES)} add entr(y/ies) ignored")
    return Policy(STALE_CLAIMS_VERSION, tuple(rules), str(path), True, tuple(warnings))


def describe(policy: Policy) -> Dict:
    """For `--show-stale-claims`: every rule; an override pattern only as a hash (it may be private)."""
    out = []
    for r in policy.rules:
        row = {"id": r.id, "action": r.action, "reason": r.reason, "ref": r.ref, "existing": r.existing, "negatable": r.negatable, "source": r.source}
        if r.source == "default":
            row["pattern"] = r.pattern
        else:
            row["pattern_sha"] = hashlib.sha256(r.pattern.encode("utf-8")).hexdigest()[:12]
        out.append(row)
    return {
        "version": policy.version, "sha": policy.sha, "override_file": policy.override_path, "override_present": policy.override_present,
        "applies_to": ["source lines before distillation (drop rules)", "scroll bullets after distillation", "knowledge-graph observations",
                       "existing scroll bullets only for rules with existing: true (logged under ## Superseded Decisions)"],
        "rules": out, "warnings": list(policy.warnings),
    }


def filter_text(text: str, policy: Optional[Policy] = None) -> Tuple[str, Counter]:
    """(text without the lines a DROP rule matches, Counter{rule id: lines}). Demote rules leave
    source lines alone: the model may see a contested claim; the host keeps it unlocked."""
    policy = policy or default_policy()
    drops = policy.drop_rules()
    if not drops or not text:
        return text, Counter()
    counts: Counter = Counter()
    kept: List[str] = []
    for line in text.split("\n"):
        hit = next((r for r in drops if r.hits(line)), None) if line.strip() else None
        if hit is not None:
            counts[hit.id] += 1
            continue
        kept.append(line)
    return "\n".join(kept), counts


# Leading host marks of a bullet, in any order: "(unconfirmed)", "(needs ... approval)", "Planned:".
_HOST_MARKS = re.compile(r"^\s*(?:(?:\(unconfirmed\)|\(needs [^)\n]{0,20}approval\)|planned\s*:)\s*)*", re.I)


def unconfirmed(line: str) -> str:
    """`line` (a bullet or plain text) with the "(unconfirmed)" prefix after its bullet marker."""
    m = re.match(r"^(\s*[\-\*\+]\s+)?(.*)$", line, re.S)
    lead, rest = (m.group(1) or ""), m.group(2)
    if UNCONFIRMED in _HOST_MARKS.match(rest).group(0).lower():
        return line  # already marked (possibly after another host mark: "Planned:", "(needs ... approval)")
    return f"{lead}{UNCONFIRMED} {rest}"


def counts_json(c: Counter) -> Dict[str, int]:
    return {k: int(v) for k, v in sorted(c.items()) if v}


def ids(rules: Sequence[Rule]) -> List[str]:
    return [r.id for r in rules]
