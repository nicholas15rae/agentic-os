"""Secret scrubbing. A port of `devqueue.rs` `secret_patterns` / `scrub_known` / `scrub`.

`tests/fixtures/scrub_parity.json` is checked by both this module's tests and a Rust unit test,
so the two implementations cannot drift apart.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Iterable, List, Mapping, Optional

REDACTED = "[redacted]"

_PATTERNS = [
    # Well-known key shapes.
    re.compile(
        r"\b(?:sk-ant-[A-Za-z0-9_\-]{10,}|sk-[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
        r"|xox[abprs]-[A-Za-z0-9\-]{10,}|AIza[0-9A-Za-z_\-]{30,}"
        r"|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})"
    ),
    # "Bearer xyz" / "Basic xyz".
    re.compile(r"(?i)\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=\-]{8,}"),
    # "token=xyz", "OPENROUTER_API_KEY=xyz", "{'api_key': 'xyz'}", "password = xyz".
    re.compile(
        r"""(?i)\b([A-Za-z0-9_\-]*?(?:authorization|api[_\-]?key|apikey|access[_\-]?token|refresh[_\-]?token|client[_\-]?secret|secret|password|passwd|pwd|token|key))(["']?\s*[:=]\s*["']?)[^\s,;"']{6,}"""
    ),
    # URL userinfo: "postgresql://user:pass@host" -> "postgresql://user:[redacted]@host".
    re.compile(r"(?i)\b([a-z][a-z0-9+.\-]*://[^\s:/@]+:)[^\s@/]+@"),
]

_RUN = re.compile(r"(?:\b([A-Za-z]):)?([A-Za-z0-9_\-+/=]{32,})")

# `.env` keys whose values are credentials (same list as devqueue::known_secrets).
DOTENV_SECRET_MARKERS = ("KEY", "SECRET", "TOKEN", "PASS", "SCRIPT_ID", "CLIENT_ID", "PAT", "AUTH")
# Process env names that hold credentials (PATH and friends are excluded on purpose).
_ENV_SECRET_NAME = re.compile(r"(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_PAT|API_KEY|CLIENT_ID|SCRIPT_ID)$")


def _has(s: str, lo: str, hi: str) -> bool:
    return any(lo <= c <= hi for c in s)


def looks_random_n(s: str, min_len: int) -> bool:
    return len(s) >= min_len and _has(s, "A", "Z") and _has(s, "a", "z") and _has(s, "0", "9")


def looks_random(s: str) -> bool:
    """A long run with upper, lower and digits (a lowercase sha256 / git SHA survives)."""
    return looks_random_n(s, 32)


def scrub_known(text: str, known: Iterable[str]) -> str:
    out = text
    ks = [k for k in known if isinstance(k, str) and len(k.strip()) >= 6]
    ks.sort(key=len, reverse=True)
    for k in ks:
        out = out.replace(k, REDACTED)
    return out


def _scrub_run(m: "re.Match[str]") -> str:
    drive = f"{m.group(1)}:" if m.group(1) else ""
    run = m.group(2)
    is_path = run.startswith("/") and (m.group(1) is not None or run.count("/") >= 2)
    if is_path:
        body = "/".join(REDACTED if looks_random_n(seg, 20) else seg for seg in run.split("/"))
    elif looks_random(run):
        body = REDACTED
    else:
        body = run
    return f"{drive}{body}"


def scrub(text: str, known: Iterable[str] = ()) -> str:
    """Remove secrets: known values, key shapes, `key=value` assignments, random-looking runs."""
    if not text:
        return text
    out = scrub_known(text, known)
    out = _PATTERNS[0].sub(REDACTED, out)
    out = _PATTERNS[1].sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", out)
    out = _PATTERNS[2].sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", out)
    out = _PATTERNS[3].sub(lambda m: f"{m.group(1)}{REDACTED}@", out)
    return _RUN.sub(_scrub_run, out)


def scrub_obj(v: Any, known: Iterable[str] = ()) -> Any:
    """Scrub every string inside a JSON-like value (dict keys are ours and stay)."""
    known = list(known)
    if isinstance(v, str):
        return scrub(v, known)
    if isinstance(v, list):
        return [scrub_obj(x, known) for x in v]
    if isinstance(v, tuple):
        return [scrub_obj(x, known) for x in v]
    if isinstance(v, dict):
        return {k: scrub_obj(x, known) for k, x in v.items()}
    return v


def parse_dotenv(text: str) -> dict:
    """Parse `.env` text (read-only helper): KEY=VALUE lines, optional `export`, quotes stripped."""
    out = {}
    text = text.lstrip("\ufeff")
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'").strip()
    return out


def read_dotenv(path: Path) -> dict:
    try:
        return parse_dotenv(Path(path).read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return {}


def known_values(dotenv: Optional[Mapping[str, str]] = None, env: Optional[Mapping[str, str]] = None, extra: Iterable[Optional[str]] = ()) -> List[str]:
    """Every credential-like value this process can see (never stored or printed)."""
    vals: List[str] = []
    for k, v in (dotenv or {}).items():
        if any(m in k.upper() for m in DOTENV_SECRET_MARKERS):
            vals.append(v)
    for k, v in (env if env is not None else os.environ).items():
        if _ENV_SECRET_NAME.search(k.upper()):
            vals.append(v)
    vals.extend(x for x in extra if x)
    seen = set()
    out = []
    for v in vals:
        v = (v or "").strip()
        if len(v) >= 6 and v not in seen:
            seen.add(v)
            out.append(v)
    return out
