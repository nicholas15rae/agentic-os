"""Typed, environment-driven config for the IBKR bridge — paper-first, live locked.

Precedence matches the rest of the repo: process env wins, then the repo-root
`.env` (re-read on every `load_config()` call, so edits need no restart).

The safety contract lives in `resolve_endpoint()`. It is the ONLY place that
turns config into a (host, port) to dial, and it is deterministic:

  * TRADING_MODE defaults to PAPER. Anything other than PAPER / LIVE locks.
  * PAPER dials exactly IBKR_PAPER_PORT, and that port must be 7497.
    A paper config pointing at 7496 (or anything else) locks — it does not
    "fall through" to live.
  * LIVE is never dialled by this build. Even with TRADING_MODE=LIVE,
    ALLOW_LIVE_EXECUTION=TRUE and a manual confirmation, `LIVE_SUPPORTED` is
    False here, so the result is LOCKED with the list of unmet gates. Turning
    live on later is a deliberate code change plus a reviewed confirmation
    flow, not an env edit.
  * The host must be loopback. TWS's API socket is never dialled over a LAN.
  * Worker client IDs must be distinct and non-zero (0 is TWS's "master"
    client, which can see and bind manual orders).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

REPO_ROOT = Path(__file__).resolve().parent.parent

PAPER_PORT = 7497
LIVE_PORT = 7496
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
# IBKR paper account ids start with DU (individual) or DF (advisor/master).
PAPER_ACCOUNT_PREFIXES = ("DU", "DF")
# Flipped only by a reviewed code change that adds the manual-confirmation flow.
LIVE_SUPPORTED = False

MODES = ("PAPER", "LIVE")
WORKERS = ("bridge", "data", "exec", "kill", "overseer", "overseer_act", "cli", "cli_act", "snapshot", "status", "kill_dry")
# 20-25: desk-cli and its overseer (trading/tws_adapter.py); each is also held under an OS lease there.
# 26: the kill switch's read-only dry run, kept off 19 so a rehearsal can never block a live E-stop.
DEFAULT_CLIENT_IDS = {"bridge": 11, "data": 12, "exec": 13, "kill": 19,
                      "overseer": 20, "overseer_act": 21, "cli": 22, "cli_act": 23, "snapshot": 24, "status": 25, "kill_dry": 26}


def _read_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        k, sep, v = line.partition("=")
        if sep:
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _truthy(v: str) -> bool:
    return v.strip().upper() in {"1", "TRUE", "YES", "ON"}


@dataclass(frozen=True)
class TradingConfig:
    mode: str = "PAPER"
    host: str = "127.0.0.1"
    paper_port: int = PAPER_PORT
    live_port: int = LIVE_PORT
    allow_live_execution: bool = False
    live_confirmed: bool = False
    client_ids: Mapping[str, int] = field(default_factory=lambda: dict(DEFAULT_CLIENT_IDS))
    # 4 = delayed-frozen: delayed ticks in RTH (no live sub on paper). Type 3 stopped returning any
    # SPY ticks on client 12 (2026-11-24) while 4 quoted in 0.2 s; the gate checks market hours itself.
    market_data_type: int = 4  # 1 live, 2 frozen, 3 delayed, 4 delayed-frozen
    bridge_port: int = 8091
    errors: tuple[str, ...] = ()


@dataclass(frozen=True)
class Endpoint:
    """Outcome of the safety check. `locked` means: do not dial anything."""

    mode: str
    host: str
    port: int | None
    locked: bool
    reasons: tuple[str, ...] = ()


def load_config(env: Mapping[str, str] | None = None, dotenv: Path | None = None) -> TradingConfig:
    """Build a TradingConfig. Malformed values are recorded in `errors` (which locks)."""
    merged = _read_dotenv(dotenv if dotenv is not None else REPO_ROOT / ".env")
    merged.update({k: v for k, v in (env if env is not None else os.environ).items() if v != ""})
    errors: list[str] = []

    def num(key: str, default: int) -> int:
        raw = merged.get(key, "")
        if raw == "":
            return default
        try:
            return int(raw)
        except ValueError:
            errors.append(f"{key} is not an integer: {raw!r}")
            return default

    ids = {w: num(f"IBKR_CLIENT_ID_{w.upper()}", DEFAULT_CLIENT_IDS[w]) for w in WORKERS}
    return TradingConfig(
        mode=merged.get("TRADING_MODE", "PAPER").strip().upper() or "PAPER",
        host=merged.get("IBKR_HOST", "127.0.0.1").strip() or "127.0.0.1",
        paper_port=num("IBKR_PAPER_PORT", PAPER_PORT),
        live_port=num("IBKR_LIVE_PORT", LIVE_PORT),
        allow_live_execution=_truthy(merged.get("ALLOW_LIVE_EXECUTION", "")),
        live_confirmed=False,  # only a UI confirmation flow may set this; never env
        client_ids=ids,
        market_data_type=num("IBKR_MARKET_DATA_TYPE", 4),
        bridge_port=num("TRADING_BRIDGE_PORT", 8091),
        errors=tuple(errors),
    )


def resolve_endpoint(cfg: TradingConfig) -> Endpoint:
    """Deterministic gate: the only path from config to a dialable socket."""
    reasons: list[str] = list(cfg.errors)

    if cfg.host not in LOOPBACK_HOSTS:
        reasons.append(f"IBKR_HOST must be loopback, got {cfg.host!r}")

    ids = list(cfg.client_ids.values())
    if any(i <= 0 for i in ids):
        reasons.append("client ids must be positive (0 is the TWS master client)")
    if len(set(ids)) != len(ids):
        reasons.append(f"client ids must be distinct per worker: {dict(cfg.client_ids)}")

    if cfg.market_data_type not in (1, 2, 3, 4):
        reasons.append(f"IBKR_MARKET_DATA_TYPE must be 1-4, got {cfg.market_data_type}")

    if cfg.mode == "PAPER":
        if cfg.paper_port != PAPER_PORT:
            reasons.append(f"PAPER mode requires port {PAPER_PORT}, config has {cfg.paper_port}")
        if reasons:
            return Endpoint("PAPER", cfg.host, None, True, tuple(reasons))
        return Endpoint("PAPER", cfg.host, PAPER_PORT, False, ())

    if cfg.mode == "LIVE":
        gates = []
        if not LIVE_SUPPORTED:
            gates.append("live trading is not enabled in this build")
        if not cfg.allow_live_execution:
            gates.append("ALLOW_LIVE_EXECUTION is not TRUE")
        if not cfg.live_confirmed:
            gates.append("manual live confirmation not given")
        return Endpoint("LIVE", cfg.host, None, True, tuple(reasons + gates))

    return Endpoint(cfg.mode, cfg.host, None, True, tuple(reasons + [f"unknown TRADING_MODE {cfg.mode!r}"]))


def data_dir() -> Path:
    """Runtime state (lock file, audit db, desk db, incidents). TRADING_DATA_DIR overrides (tests)."""
    d = Path(os.environ.get("TRADING_DATA_DIR") or REPO_ROOT / "data" / "trading")
    d.mkdir(parents=True, exist_ok=True)
    return d


def is_paper_account(account_id: str) -> bool:
    return account_id.upper().startswith(PAPER_ACCOUNT_PREFIXES)
