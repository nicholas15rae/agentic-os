"""Tier-2 personal-data filter. Pure and deterministic; reads only the optional override file.

Applies to everything that is embedded or reused (scroll bodies incl. the Superseded log, superseded
facts, knowledge-graph entities, scrolls synced to AnythingLLM). Never to the cold archive.

- Identifier detectors (emails, phone numbers, street / postal addresses, handles, coordinates)
  REDACT the value in place ("[contact removed]"); a line left with too little content is dropped.
- Keyword detectors (finance amounts and words, birth dates, health, family, private third parties,
  life plans / possessions, personality, hobby gear, consumer services, deny_terms) DROP the line.
- KG entities: an entity whose name is personal, or whose observations are mostly personal, is
  dropped whole; otherwise only its personal observations go.
- Every removal is counted per category; values are never logged, only category ids and counts.

Filtering is idempotent, so the host applies the same filter to the current scroll before comparing
(locked no-silent-loss): a locked bullet only ever disappears as an explicit privacy removal, and
`filter_body_ex` reports each such LOCKED bullet separately (heading, dropped / redacted, category)
so the host warns and emits a `privacy_locked` event for it instead of folding it into a count.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from . import common_words
from . import privacy_policy as pp
from . import scroll as sc

# ── policy ──────────────────────────────────────────────────────────────────

KNOWN = frozenset(cid for cid, *_ in pp.CATEGORIES)
MAX_TERMS = 200


@dataclass(frozen=True)
class Policy:
    version: int
    excluded: frozenset
    deny_terms: Tuple[str, ...] = ()
    source: Dict[str, str] = field(default_factory=dict)
    override_path: Optional[str] = None
    override_present: bool = False
    warnings: Tuple[str, ...] = ()
    # Automatic deny terms from the DENIED sections of the hub MASTER_IDENTITY (`with_auto_terms`):
    # hashed into `sha`, never printed (only their count).
    auto_terms: Tuple[str, ...] = ()

    @property
    def sha(self) -> str:
        d = {"v": self.version, "excluded": sorted(self.excluded), "terms": sorted(self.deny_terms)}
        if self.auto_terms:
            d["auto"] = hashlib.sha256("\n".join(sorted(self.auto_terms)).encode("utf-8")).hexdigest()
        blob = json.dumps(d, sort_keys=True)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]

    def excludes(self, cid: str) -> bool:
        return cid in self.excluded


def default_policy() -> Policy:
    ex = frozenset(cid for cid, excluded in pp.defaults().items() if excluded)
    return Policy(pp.POLICY_VERSION, ex, (), {cid: "default" for cid in KNOWN})


def override_path(state_dir) -> Path:
    return Path(state_dir) / pp.OVERRIDE_FILE


def term_is_common(term: str) -> bool:
    """True when `term` is an ordinary English word, or a phrase made only of ordinary words: it is
    then kept capitalised and only ever matches as a name (`_auto_hit`)."""
    words = (term or "").split()
    return bool(words) and all(common_words.is_common(w) for w in words)


def name_only_phrase(term: str) -> bool:
    """A multi-word term written with every word capitalised ("Hard Stop"): `offload.derive_auto_terms`
    gives a phrase of ordinary words (common, or used in lower case in the hub) that form, so it only
    matches as a name (`_phrase_hit` as_name)."""
    words = (term or "").split()
    return len(words) > 1 and all(w[:1].isupper() for w in words)


def with_auto_terms(policy: Policy, terms) -> Policy:
    """`policy` plus automatic deny terms (2..80 chars, de-duplicated, capped). A term is lower-case
    (matched in any case) unless it is an ordinary English word, or a phrase of ordinary words, which
    `offload.derive_auto_terms` keeps capitalised so it only matches as a name (`_auto_hit`)."""
    out: List[str] = []
    seen = set()
    for x in terms or ():
        s = re.sub(r"\s+", " ", x).strip() if isinstance(x, str) else ""
        if not term_is_common(s) and not name_only_phrase(s):
            s = s.lower()
        if 2 <= len(s) <= 80 and s.lower() not in seen and s.lower() not in policy.deny_terms:
            seen.add(s.lower())
            out.append(s)
    return dataclasses.replace(policy, auto_terms=tuple(sorted(out, key=str.lower)[:MAX_TERMS]))


def load(state_dir) -> Policy:
    """The effective policy: defaults, then `<state_dir>/privacy-policy.json` when present. A bad
    override never weakens the defaults: it is reported (without values) and ignored."""
    base = default_policy()
    path = override_path(state_dir)
    if not path.is_file():
        return dataclasses.replace(base, override_path=str(path))
    warnings: List[str] = []
    excluded = set(base.excluded)
    source = dict(base.source)
    terms: List[str] = []
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        data = None
        warnings.append("privacy override unreadable (not JSON): defaults used")
    if data is not None and not isinstance(data, dict):
        warnings.append("privacy override is not a JSON object: defaults used")
        data = None
    if isinstance(data, dict):
        extra = [k for k in data if k not in ("allow", "deny", "deny_terms")]
        if extra:
            warnings.append(f"privacy override: {len(extra)} unknown key(s) ignored")

        def ids(key: str) -> List[str]:
            v = data.get(key) or []
            if not isinstance(v, list):
                warnings.append(f"privacy override: {key} is not a list; ignored")
                return []
            good = [x for x in v if isinstance(x, str) and x in KNOWN]
            if len(good) != len(v):
                warnings.append(f"privacy override: {len(v) - len(good)} unknown {key} category id(s) ignored")
            return good

        allow, deny = ids("allow"), ids("deny")
        for cid in allow:
            if cid not in deny:  # deny wins over allow
                excluded.discard(cid)
                source[cid] = "override"
        for cid in deny:
            if cid in pp.NO_DETECTOR:
                warnings.append(f"privacy override: {cid} has no detector; it stays allowed")
                continue
            excluded.add(cid)
            source[cid] = "override"
        raw = data.get("deny_terms") or []
        if not isinstance(raw, list):
            warnings.append("privacy override: deny_terms is not a list; ignored")
            raw = []
        bad = 0
        for x in raw[:MAX_TERMS]:
            s = re.sub(r"\s+", " ", x).strip().lower() if isinstance(x, str) else ""
            if 2 <= len(s) <= 80:
                if s not in terms:
                    terms.append(s)
            else:
                bad += 1
        if bad or len(raw) > MAX_TERMS:
            warnings.append(f"privacy override: {bad + max(0, len(raw) - MAX_TERMS)} deny_terms entr(y/ies) ignored")
    return Policy(pp.POLICY_VERSION, frozenset(excluded), tuple(terms), source, str(path), True, tuple(warnings))


def describe(policy: Policy) -> Dict:
    """The effective policy for `--show-privacy-policy`: categories and counts, never deny_terms."""
    desc = pp.describe()
    return {
        "version": policy.version,
        "sha": policy.sha,
        "override_file": policy.override_path,
        "override_present": policy.override_present,
        "applies_to": ["scroll bodies (incl. ## Superseded Decisions)", "superseded facts", "knowledge-graph entities / kg-preview.jsonl", "scrolls synced to AnythingLLM"],
        "never_applies_to": "the cold archive (lossless; only secrets are scrubbed)",
        "categories": [
            {
                "id": cid, "label": desc[cid]["label"], "covers": desc[cid]["covers"],
                "status": "excluded" if cid in policy.excluded else "allowed",
                "source": policy.source.get(cid, "default"), "detector": cid not in pp.NO_DETECTOR,
            }
            for cid, *_ in pp.CATEGORIES
        ],
        "deny_terms": len(policy.deny_terms),
        "auto_deny_terms": len(policy.auto_terms),
        "auto_deny_terms_source": "proper nouns / abbreviations found only in the DENIED sections of the hub MASTER_IDENTITY (values never printed)",
        "warnings": list(policy.warnings),
    }


def prompt_rule(policy: Optional[Policy] = None) -> str:
    """Distiller rule 13, built from the effective policy (deny_terms are never sent)."""
    policy = policy or default_policy()
    phrases = [pp.PROMPT_PHRASES[cid] for cid, *_ in pp.CATEGORIES if cid in policy.excluded and cid in pp.PROMPT_PHRASES]
    if not phrases:
        return ""
    return (
        "13 Never record personal data in the scroll, superseded_facts or graph entities: " + "; ".join(phrases)
        + ". Work projects, system tools and models, GPU / VRAM / OS constraints, communication preferences and standing rules are fine."
    )


# ── detectors ───────────────────────────────────────────────────────────────
#
# Identifier detectors are (category, regex, validator): the validator sees the match and the whole
# line and returns False for a look-alike that is work content (a decorator, an npm scope, a list of
# image sizes, weight pairs, "Phase 2 Audit Trail"). Keyword detectors are functions of the line.

_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b")
_PHONE = re.compile(
    r"(?:(?<=tel:)|(?<=tel: )|(?<![\w.:/@+-]))"
    r"(?:\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,5}"  # international, with +
    r"|(?:1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}"  # North American, separated
    r"|\d{10,11})"  # a bare run: only next to a phone word
    r"(?![\w-])(?!\.\d)"
)
_PHONE_CTX = re.compile(r"\b(?:phone|phones|call|calls|calling|cell|mobile|tel|text|texts|sms|whatsapp|contact|reach|number|fax|dial)\b", re.I)
_STREET = re.compile(
    r"\b(?P<num>\d{1,5})[A-Za-z]?\s+(?:St\.\s+|Saint\s+|Mt\.?\s+)?(?P<name>(?:[A-Z][A-Za-z'’-]+\.?\s+){1,3})"
    r"(?P<suf>Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Crescent|Cres|Highway|Hwy|Parkway|Pkwy|Drive|Dr|Court|Ct|Lane|Ln|Way|Place|Pl|Terrace|Trail|Circle|Square|Sq)\b\.?"
    r"(?:\s+(?:N|S|E|W|North|South|East|West)\b)?"
)
_STREET_LC = re.compile(r"\b\d{1,5}[a-z]?\s+(?:[a-z][a-z'-]*\s+){1,3}(?:street|avenue|road|boulevard|drive|lane|crescent|court|way|place)\b(?P<unit>,?\s+(?:apt\.?|apartment|unit|suite|#)\s*\w+)?")
_STREET_WEAK = frozenset("drive dr court ct lane ln way place pl terrace trail circle square sq".split())
# Title words that make "<n> <Words> <suffix>" a product or feature name, not a street.
_STREET_TECH = frozenset(
    "google one audit cloud hard flash disk usb thumb network shared team data code test fast dark light critical express "
    "memory scroll skill agent pipeline release build deploy phase step stage".split()
)
_ADDR_CTX = re.compile(r"\b(?:address|lives?|living|mail(?:ing)?|deliver\w*|ship(?:ping)? to|located at|moved to|home|house|apartment|apt|suite|unit|condo)\b", re.I)
_US_STATES = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC"
_POSTAL = re.compile(
    r"\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b|(?i:\b(?:zip|postal)(?: code)?\s*:?\s*\d{5}(?:-\d{4})?\b)"
    r"|\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)?,\s*(?:" + _US_STATES + r")\s+\d{5}(?:-\d{4})?\b"
)
_HANDLE = re.compile(r"(?<![\w/@.`])@(?!(?:here|channel|everyone|all|mention)\b)([A-Za-z][A-Za-z0-9_.]{2,29})\b(?![/@\w(-])")
# @-words that are code: decorators, npm scopes, CSS at-rules, JSDoc tags.
_CODE_AT = frozenset(
    "staticmethod classmethod property dataclass dataclasses app router api bp blueprint pytest override abstractmethod cache cached_property "
    "lru_cache functools wraps contextmanager tauri types anthropic vitejs babel testing react angular vue mui emotion tanstack radix nestjs "
    "sveltejs playwright modelcontextprotocol deprecated param params returns return throws type typedef ts see link example since author "
    "todo fixme mcp openai google microsoft aws azure vercel next nuxt prisma supabase trpc storybook vitest jest swc rollup esbuild "
    "typescript eslint commitlint octokit huggingface xenova langchain llamaindex shadcn headlessui heroicons fontsource iconify lucide remix "
    "solid svelte media import keyframes tailwind apply layer font container supports charset namespace page tool validator field "
    "computed_field model_validator field_validator root_validator command task get post put patch delete route".split()
)
_COORDS = re.compile(r"(?<![\w.])(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})(?![\w.])")
_COORDS_NSEW = re.compile(r"(?<![\w.])-?\d{1,3}(?:\.\d+\s?°?|\s?°)\s?[NSns]\b[,\s]+-?\d{1,3}(?:\.\d+\s?°?|\s?°)\s?[EWew]\b")
_LATLON = re.compile(r"\blat(?:itude)?\s*[:=]?\s*-?\d{1,2}\.\d+\s*[,;/]?\s*(?:lon|lng|long(?:itude)?)\s*[:=]?\s*-?\d{1,3}\.\d+", re.I)


def _ok_phone(m: re.Match, text: str) -> bool:
    s = m.group(0)
    digits = sum(ch.isdigit() for ch in s)
    if s.startswith("+"):
        return 8 <= digits <= 15
    if digits < 10:
        return False
    # A bare run or a space-only grouping ("512 768 1024") is a phone only next to a phone word.
    if not re.search(r"[().-]", s):
        return bool(_PHONE_CTX.search(text) or text[max(0, m.start() - 4):m.start()].lower().endswith(("tel:", "tel: ")))
    return True


def _ok_street(m: re.Match, text: str) -> bool:
    words = [w.strip(".").lower() for w in m.group("name").split()]
    if any(w in _STREET_TECH for w in words):
        return False
    if m.group("suf").lower() in _STREET_WEAK:
        return len(m.group("num")) >= 2 or bool(_ADDR_CTX.search(text))
    return True


def _ok_street_lc(m: re.Match, text: str) -> bool:
    return bool(m.group("unit") or _ADDR_CTX.search(text))


def _ok_handle(m: re.Match, text: str) -> bool:
    return m.group(1).split(".")[0].lower() not in _CODE_AT and not re.search(r"\bdecorators?\b", text, re.I)


def _ok_coords(m: re.Match, text: str) -> bool:
    # Two fractions ("weights 0.125, 0.875") are not a place.
    return not (abs(float(m.group(1))) < 1 and abs(float(m.group(2))) < 1)


def _always(m: re.Match, text: str) -> bool:
    return True


# (category, regex, validator)
_REDACTORS = (
    ("contact", _EMAIL, _always),
    ("contact", _PHONE, _ok_phone),
    ("contact", _STREET, _ok_street),
    ("contact", _STREET_LC, _ok_street_lc),
    ("contact", _POSTAL, _always),
    ("contact", _HANDLE, _ok_handle),
    ("location", _COORDS_NSEW, _always),
    ("location", _LATLON, _always),
    ("location", _COORDS, _ok_coords),
)

# Strong markers that a line is about the system itself (an integration, not a personal account):
# only personal consumer services are exempt on such a line. Hobbies, life plans and possessions are
# not: "tracked in cabin.md" or "synced to the studio server" does not make a cabin build work data.
_SYSTEM = re.compile(
    r"\b(?:bridge|api|apis|mcp|webhooks?|n8n|oauth|callback|endpoint|connector|port|pub/?sub|hermes|telegram|discord|slack|channels?|heartbeat"
    r"|alerts?)\b|:\d{4,5}\b|[A-Za-z]:[\\/]",
    re.I,
)
_AGENT = re.compile(r"\b(?:agents?|persona|assistant|tony|jarvis|bot|background presence|kernel|gateway|orchestrator|librarian|dispatcher|ai|os)\b", re.I)
# The user as the subject: a trait of the user stays personal even on a line that mentions agents.
_USER_SUBJ = re.compile(r"\b(?:user|user's|nic|nic's|i|i'm|i am|me|my|owner|he|his|human)\b", re.I)
_WORK_PROJECTS = re.compile(r"\b(?:agentic[- ]os|scene[- ]reader|cloudmart|command center|memory scrolls?)\b", re.I)

_NAME_STOP = frozenset(
    "Plan Option Version Phase Step Part Type Tier Layer Section Appendix Grade Class Model Group Team Level Track Route Line Exhibit "
    "Figure Table Item Note Vitamin Mr Ms Mrs Dr St Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec Approach Variant Scenario Case "
    "Mode Path Strategy Design Pattern Stage Milestone Sprint Build Release Round Batch Wave Slot Column Row Lane Room Pass Box Bucket "
    "Zone Region Area Sector Unit Size Rank Grid Block Chapter Page Lesson Module Unit Lab Test Suite Sample Fixture Profile Config".split()
)
_SYSTEM_NAMES = frozenset(
    "claude gemini tony jarvis hermes librarian dispatcher coder conceptualizer prompter nic opencode agy github google anthropic qwen "
    "lm anythingllm openrouter cline kokoro whisper windows linux ubuntu spotify gmail whatsapp discord telegram slack the a an it this "
    "that cloudmart brave netbird digitalocean ollama n8n codex cursor vite tauri rust python node react instagram facebook meta booking "
    "docker kubernetes gcp aws azure apple microsoft openai npm pypi cloudflare vercel netlify supabase firebase notion obsidian figma "
    "stripe paypal shopify twilio zoom teams outlook chrome firefox safari edge youtube twitter reddit linkedin tiktok hugging huggingface "
    "kaggle colab antigravity owl deepseek mistral llama phi gemma nvidia amd intel osrm openstreetmap osm maps fastapi flask django uvicorn "
    "apscheduler sqlite postgres redis nginx caddy ngrok tailscale wireguard home homeassistant git gateway server client app bot agent "
    "system user scheduler router heartbeat pipeline worker cron hook webhook service script ci frontend backend dashboard kanban skill "
    "skills scroll scrolls memory mcp api ipc rpc rest http https json yaml sql reqwest axios fetch tokio serde electron jest vitest "
    "cargo pip uv brew winget powershell bash zsh cmd terminal console browser playwright puppeteer selenium lmstudio studio".split()
)
_INITIAL_NAME = re.compile(r"\b([A-Z][a-z]{1,15}) [A-Z]\.(?=[\s,;:)\]]|$)")
_FROM_NAME = re.compile(
    r"(?i:\b(?:e-?mails?|messages?|texts?|dms?|voicemails?|calls?|invites?|newsletters?|notes?|letters?|mail|replies|reply|notices?)\s+from)"
    r"\s+([A-Z][a-z]{2,})"
)
_ROLE_NAME = re.compile(
    # Lower-case role words only: "my client Sam", never a title-case label ("Client Timeout").
    r"\b(?:friend|buddy|client|customer|coworker|co-worker|colleague|neighbou?r|roommate|landlord|boss|casting director|casting agent|talent agent"
    r"|teacher|coach|classmate|recruiter|producer|director|accountant|lawyer|realtor)s?"
    r"\s+(?:(?:named|called)\s+)?([A-Z][a-z]{2,})"
)
# A role word right after one of these is a software part ("the HTTP client Reqwest"), not a person.
_TECH_QUAL = frozenset(
    "http https api rest web sdk mcp grpc db database test email mail ftp ssh oauth desktop mobile cli node python rust js ts graphql "
    "websocket ws tcp udp redis sql postgres sqlite s3 gcs rpc ipc lm openai anthropic ollama tauri dns smtp imap vpn rdp git".split()
)
_NAME_VERB = re.compile(
    r"\b([A-Z][a-z]{2,15})(?:\s([A-Z][a-z]{2,15}))?\s+(?:emailed|e-mailed|texted|messaged|dm'?d|dmed|phoned|called (?:me|nic)|wrote (?:to|back)"
    r"|replied|forwarded|invited (?:me|nic)|asked (?:me|nic))\b"
)
_APPOS = re.compile(
    r"\b([A-Z][a-z]{2,15})(?:\s[A-Z][a-z]{2,15})?,\s+(?:(?:a|an|the|my|our|his|her)\s+)?(?:casting director|casting agent|talent agent|director"
    r"|producer|recruiter|client|friend|colleague|co-?worker|landlord|teacher|coach|editor|photographer|neighbou?r|boss|accountant|lawyer|realtor)\b"
)
_SENDERS = re.compile(r"\bsenders?\b[^.\n]{0,12}\b(?:like|such as|e\.g\.|including|named)|\bspecific senders?\b", re.I)
_PERSON_ROLE = re.compile(r"\b(?:friend|buddy|client|customer|coworker|co-worker|colleague|neighbou?r|roommate|landlord|boss|sender|relative|classmate|acquaintance)s?\b", re.I)
# A person entity that is an agent / model, not a private person.
_AGENT_ENTITY = re.compile(r"^\s*(?:(?:an?|the)\s+)?(?:[\w-]+\s+){0,3}(?:agent|persona|assistant|bot|model|llm|subagent)\b|\b(?:agent|assistant|bot) persona\b", re.I)
_USER_NAMES = frozenset({"nic", "user", "owner", "me"})


def _not_person(word: str) -> bool:
    return word in _NAME_STOP or word.lower() in _SYSTEM_NAMES


def _third_party(text: str) -> bool:
    for m in _INITIAL_NAME.finditer(text):
        if not _not_person(m.group(1)):
            return True
    for m in _FROM_NAME.finditer(text):
        if not _not_person(m.group(1)):
            return True
    for m in _ROLE_NAME.finditer(text):
        before = re.findall(r"[\w-]+", text[:m.start()])
        if before and before[-1].lower() in _TECH_QUAL:
            continue
        if not _not_person(m.group(1)):
            return True
    for rx in (_NAME_VERB, _APPOS):
        for m in rx.finditer(text):
            words = [m.group(1)] + re.findall(r"[A-Z][a-z]+", m.group(0)[len(m.group(1)):].split(",")[0])
            if not any(_not_person(w) for w in words):
                return True
    return bool(_SENDERS.search(text))


# Money: an amount ($500, 500$, 500 dollars, CAD 500), a k-amount or bare number after a price word,
# an hourly / daily rate. A spending guardrail ("never book over $50 without asking") is a standing
# rule, not personal finance, unless it also names a price, quote, rate or income.
_MONEY = re.compile(
    r"[$€£¥]\s?(?:[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)(?:\.\d+)?|\b(?:[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)(?:\.\d+)?\s?(?:[$€£¥]|(?:dollars|bucks|usd|cad|eur|gbp)\b)"
    r"|\b(?:usd|cad|eur|gbp)\s?\d"
    r"|\b(?:estimates?|estimated|quotes?|quoted|price[ds]?|paid|charged?|charging|fees?|came to|invoiced|billed|earn(?:ed|s)?)\b[^.\n]{0,25}?"
    r"(?<![\w.:])(?:\d{1,3}(?:,\d{3})+|\d{3,}|\d+(?:\.\d+)?\s?k)\b(?!\s?(?:ms|s|sec|seconds|min|minutes|gb|mb|kb|tb|tokens?|bytes?|px|%|chars?|characters?|lines?|calls?|requests?|rows?|items?|files?|hz|fps|dpi)\b)"
    r"|\b\d+(?:\.\d+)?\s?(?:/\s?(?:hr|hour|h)|per (?:hour|hr))\b(?=[^\n]*\b(?:charg\w*|bill\w*|rate|paid|pay|earn\w*|fee)\b)"
    r"|\b(?:charg\w*|bill\w*|rate|paid|pay|earn\w*|fee)\b[^.\n]{0,20}?\b\d+(?:\.\d+)?\s?(?:/\s?(?:hr|hour|h|day)|per (?:hour|hr|day)|an hour|a day)\b",
    re.I,
)
_MONEY_RULE = re.compile(
    r"\b(?:never|don'?t|do not|must not|without (?:asking|approval|confirmation)|ask (?:me |nic )?first|requires? approval|alerts?|warns?"
    r"|threshold|cap(?:ped)?|limit)\b[^\n]*?\b(?:over|above|exceed\w*|more than|passes|past|under|below|up to|at most|max(?:imum)?)\b"
    r"|\b(?:over|above|exceed\w*|more than|passes|up to|at most)\b[^\n]*?\b(?:without (?:asking|approval)|ask (?:me |nic )?first|requires? approval|alerts?|warns?)\b",
    re.I,
)
_MONEY_PERSONAL = re.compile(r"\b(?:client|quotes?|quoted|estimates?|price[ds]?|charg\w*|paid|salary|income|wages?|invoic\w*|fees?|rent|mortgage|bought|sold|rates?)\b", re.I)
_FINANCE_WORDS = re.compile(
    r"\b(?:income|salary|salaries|wages?|paycheque|paycheck|net worth|savings account|bank (?:account|details|balance|card|transfer)|credit card|debit card"
    r"|card number|mortgage|rent payment|(?:my|personal|student|car|bank|a) loans?|loan payments?|(?<!tech )(?<!technical )debt\b|unpaid invoices?"
    r"|invoiced (?:the|a|my)|(?:day|swing|stock|forex|crypto|options|futures) trad\w*|trading (?:stocks|crypto|forex|options|account|on the side)"
    r"|stock (?:portfolio|picks)|crypto(?:currency)? (?:trading|portfolio|holdings)|(?:my|personal) investments?|investment (?:account|portfolio)"
    r"|investing in (?:stocks|crypto|etfs?|index funds|real estate)|price (?:estimate|quote)|quoted (?:at|for)|hourly rate|day rate|before tax"
    r"|hst|gst|tax return"
    # A paid plan / subscription tier the user is on or considering (baseline conflict #9: "a paid AI
    # plan", finance, values withheld); "free tier" and "free-tier first" are never finance.
    r"|(?:plus|pro|premium|paid|ultra) (?:plan|tier|subscription|membership)s?"
    r"|(?:upgrad\w+|downgrad\w+) to (?:plus|pro|premium|ultra)|(?:pro|premium|ultra) (?:being )?considered)\b",
    re.I,
)


def _finance(text: str) -> bool:
    if _FINANCE_WORDS.search(text):
        return True
    if _MONEY.search(text):
        return not (_MONEY_RULE.search(text) and not _MONEY_PERSONAL.search(text))
    return False


_LOCATION = (
    re.compile(
        # "route to <agent>" is routing in this system: only home / work routes count.
        r"\b(?:commut\w*|(?:my|nic'?s|daily|usual) travel time|travel time (?:to|from) (?:work|home|the studio|school|the office)"
        r"|directions? (?:to|from) (?:my|home|work)|routes? (?:home|from (?:home|work)|to (?:work|home))|(?:drive|ride|walk|bike|cycle|bus|subway|train) (?:to|from) (?:work|home)"
        r"|\d+[- ]min(?:ute)?s? (?:drive|ride|walk|commute)|neighbou?rhood"
        r"|my (?:home|house|apartment|condo|street|address|block)(?!\s+(?:folder|directory|dir|drive|page|screen|path|tab|server|lab|network|assistant|automation)\b)"
        r"|home address|(?:i|nic|he|she|user) lives? (?:in|on|at|near)|go transit|subway line|streetcar)\b",
        re.I,
    ),
    re.compile(
        r"\b(?!(?:Charging|Charge|Docking|Base|Weather|Work|Power|Play|Ground|Space|Service|Battery|Radio|Test|Lab|Audio|Docker|Media|Game|Gas|Fire|Police|Polling)\b)"
        r"[A-Z][a-z]+ (?:Station|Stn)\b|\bTTC\b"
    ),
    # v3: an IANA time zone (Region/City) names the operator's city or region.
    re.compile(r"\b(?:America|Europe|Asia|Africa|Australia|Pacific|Atlantic|Indian|Antarctica)/[A-Z][A-Za-z_-]+(?:/[A-Z][A-Za-z_-]+)?\b"),
)
_DOB_AGE = re.compile(
    r"\b(?:date of birth|d\.o\.b\.?|dob|birthdays?|birth ?date|birth ?year|born (?:on|in) |born \d|\d{1,3} ?(?:years?|yrs?) old|\d{1,3}-years?-old"
    r"|\d{1,3} ?yo\b|aged \d{1,3})"
    r"|(?<!max-)(?<!max_)(?<!cache )\bage(?::\s*|\s+)\d{1,3}\b(?!\s*(?:days?|hours?|h|ms|s|sec|seconds?|minutes?|mins?|weeks?)\b)",
    re.I,
)
_HEALTH = re.compile(
    r"\b(?:diagnosed with|(?:my|his|her|nic'?s) diagnos[ie]s|medical diagnos\w*|medications?|prescri(?:bed|ption)\w*|therap(?:y|ist|ies)|psychiatr\w+"
    r"|psychologist|my doctor|the doctor|doctor'?s appointment|dentist|hospital\w*|clinic|surgery|surgical|injur(?:y|ies|ed)|illness|chronic"
    r"|allerg(?:y|ies|ic)|adhd|autis\w+|anxiety|depress(?:ion|ed)|bipolar|ptsd|insomnia|migraines?|blood pressure|diabet\w+|asthma|mental health"
    r"|physio\w*|back pain|concussion|covid|sick (?:day|leave)|(?:has|have|with) a disability|(?:my|his|her) disabilit(?:y|ies)|disability (?:benefits|claim|leave)"
    # v4: diet, nutrition and body metrics
    r"|diet(?:s|ing|ary)?|nutrition(?:al|ist)?|calori(?:e|es|c)|kcal|macronutrients?|protein (?:intake|target|goal|needs?|calculator|counter|tracker|shakes?)"
    r"|(?:daily )?protein grams|body ?weight|weigh-?ins?|weight (?:loss|gain|goal|target|tracking)|lose weight|gain weight|bmi|body mass(?: index)?|body fat"
    r"|activity level|meal plan\w*|tdee|bmr|bulking"
    # v5: "macros" / "fasting" / "cutting" only in a diet context ("Rust macros", "Fasting mode: the
    # HUD ...", "cutting phase of the video edit" are not health).
    r"|(?:my|daily|track(?:ing|ed|s)?|count(?:ing|ed|s)?|hit(?:ting)?(?: my)?|log(?:ging|ged|s)?(?: my)?) macros"
    r"|macros (?:for the (?:day|week)|per (?:day|meal)|target|goal|split|count|tracker|calculator)"
    r"|macro (?:split|targets?|goals?|tracker|tracking|counting)|intermittent fasting|water fast(?:ing)?"
    r"|fasting (?:window|days?|schedule|hours?|period|protocol|glucose)|(?:i'?m|am|is|was|been|while|during|start(?:ed|ing)?|break(?:ing)?|after) fasting"
    r"|\d+[:/]\d+ fasting|(?:bulking|cutting) (?:phase|season|cycle|diet)(?! of\b))\b",
    re.I,
)
# A guardrail on what the agent may say ("never give medical diagnoses or dosage advice").
_ADVICE_RULE = re.compile(
    r"\b(?:never|don'?t|do not|no|not|must not)\b[^.\n]{0,40}\b(?:give|giving|provide|offer|make|share)\b[^.\n]{0,40}\b(?:advice|diagnos\w*|dosage|prescriptions?)\b",
    re.I,
)
_FAMILY = re.compile(
    r"\b(?:my|his|her|their|our|nic'?s)\s+(?P<rel>mom|mum|mother|dad|father|parents?|parent's|brother|sister|siblings?|son|daughter|kids?|children|child|wife|husband"
    r"|girlfriend|boyfriend|partner|fianc[ée]e?|spouse|grand(?:ma|pa|mother|father|parents?|kids?|children)|aunt|uncle|cousins?|niece|nephew|family"
    r"|relatives?|in-laws?|ex)\b"
    r"|\b(?:girlfriend|boyfriend|fianc[ée]e?|spouse|married|divorced?|breakup|broke up|dating|anniversary|wedding|pregnan\w+)\b",
    re.I,
)
# parent / child / sibling as a data-structure relation (tasks, nodes, processes), not family.
_TREE_RELS = frozenset({"parent", "parents", "parent's", "child", "children", "sibling", "siblings"})
_TREE_CTX = re.compile(
    r"\b(?:tasks?|subtasks?|nodes?|trees?|kanban|process(?:es)?|threads?|class(?:es)?|components?|elements?|director(?:y|ies)|folders?|branch(?:es)?"
    r"|commits?|widgets?|windows?|issues?|tickets?|cards?|items?|entit(?:y|ies)|records?|rows?|dom|xml|json|spans?|scrolls?|goals?|jobs?|links?)\b",
    re.I,
)


def _family(text: str) -> bool:
    tree = bool(_TREE_CTX.search(text))
    for m in _FAMILY.finditer(text):
        rel = (m.group("rel") or "").lower()
        if tree and rel in _TREE_RELS:
            continue
        return True
    return False


_LIFE_PLANS = (
    re.compile(
        r"\b(?:getting land|buy(?:ing)? (?:land|a house|a home|a condo|property|a cottage|a car|a truck|a van|a bus|an rv)|land (?:purchase|plot|hunting|plans?)"
        r"|(?:plot|piece|parcel|acres?) of land|build(?:ing)? (?:a |my |our )?(?:cabin|cottage|house|home|tiny house)"
        r"|cottage|cabin build|homestead\w*|off[- ]grid|bus build|van build|vanlife|camper(?:van)?|skoolie|vehicle build|car build"
        r"|(?:my|nic'?s|early|planning (?:for )?|saving for) retirement|retirement (?:plans?|savings|fund|account|age)"
        r"|life coach\w*|mushroom\w*|side hustle|road trip|vacation|holiday plans?|car enthusiast|car guy|brake jobs?|oil change|suspension (?:work|job)"
        r"|(?:car|truck|wagon|van|motorcycle|suv) owner|own(?:s|ed)? (?:a|an|my) (?:car|truck|wagon|van|bus|motorcycle|motorbike|suv|sedan|coupe|jeep|pickup)"
        r"|smart ?tv|television|home theat(?:er|re)|soundbar|game console|playstation|ps5|xbox|nintendo switch|smart home|thermostat|doorbell"
        r"|robot vacuum|roomba|air fryer)\b",
        re.I,
    ),
    re.compile(r"\b(?:BMW|Audi|Honda|Toyota|Ford|Chevy|Chevrolet|Subaru|Mazda|Nissan|Volkswagen|Jeep|Dodge|Hyundai|Kia|Volvo|Porsche|Mercedes)\b"),
)
# Side ventures: personal unless the line names a work project.
_SIDE = re.compile(r"\b(?:side projects?|side ventures?|side business(?:es)?|side gigs?|personal (?:apps?|projects?)(?: built)?|apps? (?:i|nic) built)\b", re.I)


def _life_plans(text: str) -> bool:
    if any(rx.search(text) for rx in _LIFE_PLANS):
        return True
    return bool(_SIDE.search(text)) and not _WORK_PROJECTS.search(text)


_PERSONALITY = re.compile(
    r"\b(?:personality|temperament|character traits?|personal traits?|introvert\w*|extrovert\w*|ambivert|empath(?:ic|y)?|people person|perfectionist"
    r"|night owl|philosopher|motivator|public speaker|natural leader|enneagram|mbti|myers[- ]briggs|zodiac|star sign)\b",
    re.I,
)
# v4: a judgement of the user's temperament or character ("gets quirky when pushed", "open book, but
# people have to ask", "stubborn"), not a trait keyword. Agent persona / output-style lines with no
# user subject stay exempt (`keyword_category`).
_PERSONALITY_JUDGEMENT = re.compile(
    r"\b(?:gets?|becomes?|turns?|goes|can be|is)\s+(?:\w+\s+){0,2}(?:quirky|nerdy|defensive|stubborn|grumpy|moody|emotional|intense|shy|quiet|loud|guarded|blunt|impatient|sarcastic)\b"
    r"[^\n]{0,40}\bwhen\b"
    r"|\bwhen (?:he(?:'s| is)? |nic(?:'s| is)? )?(?:pushed|challenged|stressed|criticized|criticised|upset|tired|frustrated|pressured|provoked|cornered)\b"
    r"|\bopen book\b|\bpeople (?:have|need) to ask\b|\b(?:closed[- ]off|hot[- ]headed|short[- ]tempered|thin[- ]skinned|headstrong|strong[- ]willed|easy ?going|laid[- ]back)\b"
    r"|\b(?:he|nic|the user|user)(?:'s| is)\s+(?:very |quite |pretty |a bit |kind of |fairly )?(?:stubborn|private|reserved|guarded|sensitive|shy|introverted|extroverted|impatient|competitive|blunt|open-minded|closed-minded)\b",
    re.I,
)
_CREATIVE = re.compile(
    r"\b(?:guitars?|bass guitar|pianos?|drum kit|drums|instruments|singing|dadgad|studio one|ableton|logic pro|pro tools|fl studio|cubase|daw|sm7b|shure"
    r"|audio interface|ua volt|universal audio|focusrite|neural dsp|soundtoys|sonible|cymatics|arturia|kontakt|native instruments|getgood|waves plugins?"
    r"|izotope|vst\d?s?|recording gear|recording setup|home studio|canon|nikon|fujifilm|dslr|mirrorless|lightroom|photoshop|acdsee|capcut|davinci"
    r"|premiere pro|final cut|after effects|photo editing|video editing|raw editing|tube lights?|rgb (?:tube )?lights?|ring light|softbox|gimbal"
    r"|photograph(?:y|er|ers)|craftsman|crafting|handmade|jewel(?:le)?ry|necklaces?|sewing|knitting|crochet|embroider\w*|backstitch\w*|fabric work"
    r"|woodwork\w*|pottery|dancing|gardening)\b",
    re.I,
)
_CONSUMER = (
    re.compile(
        r"^\W*(?:(?:music|streaming|news|podcast|shopping|casting(?: call)?|audition|dating|fitness|gaming)\s*(?:service|source|provider|platform|app|account|site)?"
        r"|(?:video|email|e-mail|messaging|social(?: media)?|banking|food delivery|delivery|ride ?share)\s*(?:service|source|provider|platform|app|account|site))s?\W*:",
        re.I,
    ),
    re.compile(
        r"\b(?:music service|news source|streaming service|casting (?:call )?platform|email provider|messaging platform|(?:my|our|family|friends'?|personal) group chats?"
        r"|playlists?|(?:my|personal|streaming|music|video|news|paid|monthly) subscriptions?|watch history|listening history|food delivery|uber eats|doordash|netflix)\b",
        re.I,
    ),
)
_HARDWARE = re.compile(r"\b(?:gpu|vram|cpu|ram|ryzen|intel core|rtx ?\d{3,4}|gtx ?\d{3,4}|radeon|thinkpad|macbook|laptop|desktop pc|\d+ ?gb ram)\b", re.I)


def _rx(*rxs):
    return lambda text: any(rx.search(text) for rx in rxs)


# category -> detector(text). Order is the reporting order when a line hits several.
_KEYWORDS: Dict[str, Callable[[str], bool]] = {
    "location": _rx(*_LOCATION),
    "finance": _finance,
    "dob_age": _rx(_DOB_AGE),
    "health": lambda text: bool(_HEALTH.search(text)) and not _ADVICE_RULE.search(text),
    "family": _family,
    "life_plans": _life_plans,
    "personality": _rx(_PERSONALITY, _PERSONALITY_JUDGEMENT),
    "creative_gear": _rx(_CREATIVE),
    "consumer_services": _rx(*_CONSUMER),
    "system_hardware": _rx(_HARDWARE),
}
# Keyword categories whose match is ignored on a line that is clearly about a system integration.
_SYSTEM_EXEMPT = frozenset({"consumer_services"})


# Between the words of a multi-word term: any run of spaces, "-", "_" or "." (or nothing): "Foo Bar"
# is also "FooBar", "foo-bar", "foo_bar" and "foobar" (a folder or site name in a path).
_PHRASE_SEP = r"[\s_.\-]{0,3}"
_RX_CACHE: Dict[Tuple[str, bool], "re.Pattern[str]"] = {}


def _phrase_rx(term: str) -> "re.Pattern[str]":
    key = (term, True)
    rx = _RX_CACHE.get(key)
    if rx is None:
        rx = re.compile(_PHRASE_SEP.join(re.escape(w) for w in term.split()), re.I)
        _RX_CACHE[key] = rx
    return rx


def _bounded(text: str, s: int, e: int) -> bool:
    """True when text[s:e] is a whole word or name: no letter / digit glued on either side, except a
    camel-case join ("MyFooBar", "FooBarSite": a lower-case letter or digit then an upper-case one)."""
    if s > 0 and text[s - 1].isalnum() and not (text[s].isupper() and (text[s - 1].islower() or text[s - 1].isdigit())):
        return False
    if e < len(text) and text[e].isalnum() and not (text[e].isupper() and (text[e - 1].islower() or text[e - 1].isdigit())):
        return False
    return True


def _word_hit(text: str, term: str) -> bool:
    """`term` (one word, any case) in `text` as a whole word, or joined camel-case ("FooLabs")."""
    rx = _RX_CACHE.get((term, False))
    if rx is None:
        rx = _RX_CACHE[(term, False)] = re.compile(re.escape(term), re.I)
    return any(_bounded(text, m.start(), m.end()) for m in rx.finditer(text))


def _phrase_hit(text: str, term: str, as_name: bool) -> bool:
    """A multi-word `term` in `text`, spacing / case / punctuation-insensitive. `as_name` (a phrase
    of ordinary words, e.g. "Green Leaf"): a separated form only counts capitalised as written in
    mid-sentence, a joined one only with each word's capital ("GreenLeaf", never "greenleaf" or a
    camel-case identifier such as "hardStop"); "a green leaf" never counts."""
    words = term.split()
    for m in _phrase_rx(term).finditer(text):
        s, e = m.start(), m.end()
        if not _bounded(text, s, e):
            continue
        frag = text[s:e]
        joined = re.fullmatch(r"[A-Za-z0-9]+", frag) is not None
        if not as_name:
            return True
        if joined:
            starts, pos = [], 0
            for w in words:
                starts.append(pos)
                pos += len(w)
            if pos == len(frag) and all(frag[i].isupper() for i in starts):
                return True
            continue
        # Separated: every word capitalised as in the term, after a lower-case word, a digit or a
        # comma / bracket (mid-sentence, the `_MID` shape), never at a line or label start.
        parts = re.split(r"[\s_.\-]+", frag)
        if [p[:1] for p in parts] == [w[:1] for w in words] and s >= 2 and re.match(r"[a-z0-9,;)\]] ", text[s - 2:s]):
            return True
    return False


def _term_hit(text: str, terms: Sequence[str]) -> bool:
    """An override deny term in `text` (any case); a multi-word one spacing / punctuation-insensitive."""
    for t in terms:
        if " " in t:
            if _phrase_hit(text, t, False):
                return True
        elif _word_hit(text, t):
            return True
    return False


# A capitalised term in mid-sentence: after a lower-case word, a digit or a comma / bracket (the
# shape `offload._PROPER` found it in), so a label or a sentence start ("Anchor: ...") is not one.
_MID = r"(?<=[a-z0-9,;)\]] )"


def _auto_hit(text: str, terms: Sequence[str]) -> bool:
    """An automatic hub deny term in `text`: a lower-case term in any case (a whole word, or joined
    camel-case in a name or path); a capitalised one (an ordinary English word, e.g. "Orbit") only as
    written, in mid-sentence, i.e. as a name; never the plain word ("a fixed orbit"). A multi-word
    term matches spacing / case / punctuation-insensitively ("Foo Bar" = "FooBar", "foo-bar",
    "foo_bar", "foobar"), a phrase of ordinary words only as a name or joined (`_phrase_hit`)."""
    for t in terms:
        if " " in t:
            if _phrase_hit(text, t, t != t.lower()):
                return True
            continue
        if t != t.lower():
            if re.search(_MID + re.escape(t) + r"(?!\w)", text):
                return True
            continue
        if _word_hit(text, t):
            return True
    return False


def keyword_category(text: str, policy: Policy, user_subject: bool = False) -> Optional[str]:
    """The first excluded keyword category `text` belongs to (None when allowed). `user_subject`:
    the text describes the user (a person entity's observation), so an agent word never makes a
    personality trait an agent persona."""
    if policy.deny_terms and _term_hit(text, policy.deny_terms):
        return pp.CUSTOM
    system = bool(_SYSTEM.search(text))
    for cid, hit in _KEYWORDS.items():
        if cid not in policy.excluded:
            continue
        if cid in _SYSTEM_EXEMPT and system:
            continue
        if cid == "personality" and not user_subject and _AGENT.search(text) and not _USER_SUBJ.search(text):
            continue
        if hit(text):
            return cid
    if "third_party" in policy.excluded and _third_party(text):
        return "third_party"
    # Automatic hub deny terms last, so a line a built-in detector names keeps that category.
    if policy.auto_terms and _auto_hit(text, policy.auto_terms):
        return pp.HUB_DENIED
    return None


_LABEL = re.compile(r"^\s*(?:[-*+]\s+)?(?:\*\*[^*]{1,40}\*\*|[A-Za-z][\w &/-]{0,30})\s*:\s*")
_STOPWORDS = frozenset("the a an and or of to in on for with by is are be as at from this that it its not no".split())


def _content_words(text: str) -> int:
    t = _LABEL.sub("", text, count=1)
    t = re.sub(r"\[[a-z_ ]+ removed\]", " ", t)
    return sum(1 for w in re.findall(r"[A-Za-z]{3,}", t) if w.lower() not in _STOPWORDS)


def redact(text: str, policy: Policy) -> Tuple[str, List[str]]:
    """(text with identifiers replaced by "[<category> removed]", categories redacted)."""
    cats: List[str] = []
    out = text
    for cid, rx, ok in _REDACTORS:
        if cid not in policy.excluded:
            continue
        marker = f"[{cid} removed]"
        src = out
        new = rx.sub(lambda m: marker if ok(m, src) else m.group(0), out)
        if new != out:
            cats.append(cid)
            out = new
    return out, cats


def check_line(text: str, policy: Policy, user_subject: bool = False) -> Tuple[Optional[str], str]:
    """(category when the line must be dropped, else None; the line, redacted when needed).

    A redacted line with fewer than 3 content words left (beyond its label) is dropped under the
    redaction's category; a line matching a keyword category is dropped under that category."""
    red, cats = redact(text, policy)
    if cats and _content_words(red) < 3:
        return cats[0], red
    cat = keyword_category(red, policy, user_subject)
    if cat:
        return cat, red
    return None, red


# ── filters ─────────────────────────────────────────────────────────────────

_HEADING = re.compile(r"^(#{1,6})\s+(\S.*?)\s*#*\s*$")
# Headings the host / template owns: never filtered (a required heading must survive).
_FIXED_HEADINGS = frozenset(h for hs in sc.TEMPLATES.values() for h in hs) | {sc.SUPERSEDED, sc.SUB_SCROLLS}


@dataclass
class BodyFilter:
    """What `filter_body_ex` did: the new body, Counter{category: lines}, and every LOCKED bullet it
    dropped or redacted as (section, "dropped" | "redacted", category); categories only, no values."""
    body: str
    counts: Counter
    locked: List[Tuple[str, str, str]]


def filter_body_ex(body: str, policy: Optional[Policy] = None) -> BodyFilter:
    """Filter every line of `body` (any section, incl. the log). The H1 title, template H2s and blank
    lines are never touched; any other heading is filtered like a line (a personal heading becomes
    "[<category> removed]", so its section stays a section)."""
    policy = policy or default_policy()
    counts: Counter = Counter()
    locked: List[Tuple[str, str, str]] = []
    out: List[str] = []
    sec: Optional[str] = None
    for line in (body or "").split("\n"):
        if not line.strip():
            out.append(line)
            continue
        h = _HEADING.match(line)
        if h:
            level, text = len(h.group(1)), h.group(2)
            if level == 1 or text in _FIXED_HEADINGS:
                if level == 2:
                    sec = text
                out.append(line)
                continue
            cat, red = check_line(text, policy)
            if cat:
                counts[cat] += 1
                text = f"[{cat} removed]"
            elif red != text:
                counts[redact(text, policy)[1][0]] += 1
                text = red
            line = f"{h.group(1)} {text}"
            if level == 2:
                sec = text
            out.append(line)
            continue
        cat, red = check_line(line, policy)
        is_locked = sec in sc.LOCKED_HEADINGS and bool(sc._BULLET.match(line))
        if cat:
            counts[cat] += 1
            if is_locked:
                locked.append((sec, "dropped", cat))
            continue
        if red != line:
            _, cats = redact(line, policy)
            counts[cats[0]] += 1
            if is_locked:
                locked.append((sec, "redacted", cats[0]))
        out.append(red)
    return BodyFilter("\n".join(out), counts, locked)


def filter_body(body: str, policy: Optional[Policy] = None) -> Tuple[str, Counter]:
    """(body without personal lines, Counter{category: lines removed or redacted})."""
    r = filter_body_ex(body, policy)
    return r.body, r.counts


def filter_scroll_ex(s, policy: Optional[Policy] = None):
    """(a copy of scroll `s` with its body filtered, Counter, locked removals); None-safe."""
    if s is None:
        return None, Counter(), []
    r = filter_body_ex(s.body, policy)
    return (dataclasses.replace(s, body=r.body) if r.counts else s), r.counts, r.locked


def filter_scroll(s, policy: Optional[Policy] = None):
    """(a copy of scroll `s` with its body filtered, Counter); (None, Counter()) for None."""
    s2, counts, _ = filter_scroll_ex(s, policy)
    return s2, counts


def locked_summary(locked: Sequence[Tuple[str, str, str]]) -> str:
    """"## Standing Rules: finance dropped x1, contact redacted x1" (categories and counts only)."""
    by = Counter(locked)
    parts: Dict[str, List[str]] = {}
    for (sec, action, cat), n in sorted(by.items()):
        parts.setdefault(sec, []).append(f"{cat} {action} x{n}")
    return "; ".join(f"## {sec}: {', '.join(v)}" for sec, v in parts.items())


def locked_json(locked: Sequence[Tuple[str, str, str]]) -> List[Dict[str, Any]]:
    return [{"section": sec, "action": action, "category": cat, "count": n} for (sec, action, cat), n in sorted(Counter(locked).items())]


def _is_agent_entity(name: str, obs: Sequence[str]) -> bool:
    first = (name.replace("_", " ").split() or [""])[0].lower()
    if first in _SYSTEM_NAMES and first not in _USER_NAMES:
        return True
    return any(_AGENT_ENTITY.search(o) for o in obs)


def filter_entities(entities: Iterable, policy: Optional[Policy] = None) -> Tuple[List[dict], Counter]:
    """(entities without personal data, Counter{category: entities or observations removed}).

    An entity goes whole when its name is personal (any detector), when it is a person other than
    the user or an agent (a private third party), or when most of its observations are personal.
    The user's own observations are checked with the agent exemption off (a trait stays personal)."""
    policy = policy or default_policy()
    counts: Counter = Counter()
    out: List[dict] = []
    for e in entities or []:
        if not isinstance(e, dict):
            out.append(e)
            continue
        name = str(e.get("name") or "")
        spaced = name.replace("_", " ")
        obs = [o for o in (e.get("observations") or []) if isinstance(o, str)]
        person = e.get("entityType") == "person"
        is_user = person and (spaced.split() or [""])[0].lower() in _USER_NAMES
        cat, red = check_line(spaced, policy)
        if not cat and red != spaced:
            _, cats = redact(spaced, policy)
            cat = cats[0]
        if not cat and "third_party" in policy.excluded and person and not is_user and not _is_agent_entity(name, obs):
            cat = "third_party"
        if cat:
            counts[cat] += 1
            continue
        kept: List[str] = []
        dropped: List[str] = []
        for o in obs:
            c, r = check_line(o, policy, user_subject=is_user)
            if c:
                dropped.append(c)
                continue
            if r != o:
                _, cats = redact(o, policy)
                counts[cats[0]] += 1
            kept.append(r)
        if dropped and (not kept or (len(dropped) * 2 > len(obs) and not is_user)):
            counts[Counter(dropped).most_common(1)[0][0]] += 1
            continue
        for c in dropped:
            counts[c] += 1
        out.append({**e, "observations": kept} if (dropped or kept != obs) else e)
    return out, counts


def filter_facts(facts: Iterable, policy: Optional[Policy] = None) -> Tuple[List[dict], Counter]:
    """(superseded facts without a personal old / new / reason, Counter). A personal fact goes whole:
    its log line would carry the value. Dropping is safe for no-silent-loss: a non-personal locked
    bullet that loses its excusing fact makes `sc.validate` reject the reply."""
    policy = policy or default_policy()
    counts: Counter = Counter()
    out: List[dict] = []
    for f in facts or []:
        if not isinstance(f, dict):
            out.append(f)
            continue
        cat = None
        for k in ("old", "new", "reason"):
            v = f.get(k)
            if isinstance(v, str) and v.strip():
                c, r = check_line(v, policy)
                if c or r != v:
                    cat = c or redact(v, policy)[1][0]
                    break
        if cat:
            counts[cat] += 1
            continue
        out.append(f)
    return out, counts


# ── tallies (category ids and counts only) ──────────────────────────────────

WHERE = ("current_scroll", "body", "facts", "entities")


def new_tally() -> Dict[str, Counter]:
    return {w: Counter() for w in WHERE}


def add_tally(into: Dict[str, Counter], other: Dict[str, Counter]) -> None:
    for w, c in (other or {}).items():
        into.setdefault(w, Counter()).update(c)


def tally_json(t: Dict[str, Counter]) -> Dict[str, Dict[str, int]]:
    return {w: dict(sorted(c.items())) for w, c in (t or {}).items() if c and sum(c.values())}


def tally_total(t: Dict[str, Counter]) -> Counter:
    out: Counter = Counter()
    for c in (t or {}).values():
        out.update(c)
    return out


def summary(c: Counter) -> str:
    return ", ".join(f"{k} x{n}" for k, n in sorted(c.items()) if n)
