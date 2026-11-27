"""Tier-2 personal-data policy: the repo-tracked DEFAULTS (categories, descriptions, safe defaults).

Tier 2 is everything that gets embedded or reused across sessions: scroll bodies (the Superseded log
included), knowledge-graph entities (`graph_entities_to_upsert` / `kg-preview.jsonl`) and every
scroll synced to AnythingLLM. The cold archive (Tier 3) is never embedded and stays lossless (only
secrets are scrubbed there); this policy never applies to it.

Nic can override the defaults per machine with `<state_dir>/privacy-policy.json` (default
`data/memory-scrolls/privacy-policy.json`, gitignored; only ever read, never written):

    {"allow": ["creative_gear"], "deny": ["system_hardware"], "deny_terms": ["some private word"]}

`allow` / `deny` take category ids from CATEGORIES; `deny_terms` are extra words or phrases (kept
only in that local file, never printed) whose lines / entities are always removed (category
"custom"). `python -m memory_scrolls status --show-privacy-policy` prints the effective policy.

No personal values live here: only category names, generic keywords and brand names.
"""

from __future__ import annotations

from typing import Dict, Tuple

# Bump when a detector or a default changes what Tier 2 may hold: an offload preview records the
# version (and the effective policy's hash) and `--apply` refuses a preview made under another one.
# v2: detector fixes (phone / address / coordinate / age / finance forms, person entities, headings,
# narrower system and agent exemptions, fewer work-content false positives).
# v3: an IANA time zone (Region/City) is a precise location.
# v4: diet / nutrition / body-metric terms are health; judgements of the user's temperament are
# personality; automatic deny terms from the DENIED sections of the hub MASTER_IDENTITY (hashed
# into the policy sha, never stored or printed; category HUB_DENIED).
# v5: fewer false positives: an automatic deny term that is an ordinary English word only matches
# capitalised in mid-sentence (as a name); chat / tech abbreviations (PR, BTW, ...) are never one;
# bare "macros", "fasting" and "cutting phase" need a diet context to count as health.
# v6: multi-word deny terms (automatic and override) match spacing / case / punctuation-insensitively
# ("Foo Bar" = "FooBar", "foo-bar", "foo_bar", "foobar" in a path), a phrase of ordinary words only as
# a name or joined; automatic terms add the multi-word names of the DENIED sections; a one-word term
# also matches joined camel-case ("FooLabs").
# v7: an automatic multi-word term of ordinary words (each common, system vocabulary or used in lower
# case in the hub: "Hard Stop", "Every Friday") stays a name-only term, and a name-only phrase matches
# joined only with each word's capital ("HardStop"), never "hardStop" / "hard-stop" / "lighthouse".
POLICY_VERSION = 7
OVERRIDE_FILE = "privacy-policy.json"

# (id, label, description, excluded by default)
CATEGORIES: Tuple[Tuple[str, str, str, bool], ...] = (
    ("contact", "Contact identifiers", "email addresses, phone numbers, street / postal addresses, handles of private people", True),
    ("location", "Precise location", "home / neighbourhood, routes and commutes, transit stations, coordinates, IANA time zones", True),
    ("finance", "Finance", "prices, quotes and estimates, rates, income, bank / card details, budgets in money, trading and investing", True),
    ("dob_age", "Date of birth / age", "birthdays, dates of birth, birth year, age", True),
    ("health", "Health", "conditions, diagnoses, medication, therapy, injuries, doctors, diet / nutrition / calorie and protein intake, body weight, BMI, activity level", True),
    ("family", "Family and relationships", "relatives, partners, dating, marriage", True),
    ("third_party", "Third-party private people", "names of non-public people: email senders, friends, clients, coworkers", True),
    ("life_plans", "Life plans and personal possessions", "land / property plans, vehicles owned or built, home hardware, side ventures, trading plans", True),
    ("personality", "Personality traits", "the user's own personality, temperament and character traits, and judgements of them (how he reacts when pushed, how open or stubborn he is); an agent persona or output style is not personal data", True),
    ("creative_gear", "Personal hobbies and creative gear", "musical instruments, recording gear and plugins, photo / video gear and editing tools, crafts and other hobbies", True),
    ("consumer_services", "Personal consumer services", "personal music / news / video / casting / shopping / email / messaging accounts the user consumes", True),
    ("work_projects", "Work projects", "agentic-os, scene-reader, CloudMart and other work projects", False),
    ("work_tools", "Work tools and software stack", "editors, CLIs, models, MCP servers, frameworks the system runs on", False),
    ("system_hardware", "System hardware constraints", "GPU / VRAM / RAM / CPU and OS of the machines that run the system", False),
    ("communication_prefs", "Communication preferences", "tone, reply length, voice, how the user wants answers", False),
    ("standing_rules", "Standing rules", "guardrails, policies and standing preferences", False),
    ("system_services", "Public services / APIs used by the system", "APIs, bridges, MCP servers and integrations the system calls", False),
)

# Categories with no detector: always kept, a `deny` of one is reported and ignored.
NO_DETECTOR = frozenset({"work_projects", "work_tools", "communication_prefs", "standing_rules", "system_services"})

CUSTOM = "custom"
# Lines / entities naming an automatic deny term (a proper noun or abbreviation found only in the
# DENIED sections of the hub MASTER_IDENTITY).
HUB_DENIED = "hub_denied"


# Terse phrase per excluded category for the distiller prompt rule (built from the effective policy).
PROMPT_PHRASES: Dict[str, str] = {
    "contact": "contact details (emails, phone numbers, addresses, handles)",
    "location": "precise locations (home, neighbourhood, routes, commutes, stations, coordinates)",
    "finance": "money (prices, quotes, estimates, rates, income, banking, trading)",
    "dob_age": "birth dates or age",
    "health": "health (incl. diet, nutrition, calories, body weight, activity level)",
    "family": "family and relationships",
    "third_party": "names of private people (email senders, friends, clients)",
    "life_plans": "life plans and personal possessions (land, vehicles, home hardware)",
    "personality": "the user's personality traits or judgements of his temperament",
    "creative_gear": "personal hobbies and hobby gear (instruments, recording, photo or video gear, crafts)",
    "consumer_services": "personal consumer services (music, news, casting, email or messaging accounts)",
    "system_hardware": "machine hardware details",
}


def defaults() -> Dict[str, bool]:
    """{category id: excluded} as shipped."""
    return {cid: excluded for cid, _, _, excluded in CATEGORIES}


def describe() -> Dict[str, Dict[str, str]]:
    return {cid: {"label": label, "covers": desc} for cid, label, desc, _ in CATEGORIES}
