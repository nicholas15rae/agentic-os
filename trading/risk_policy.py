"""`data/trading/risk-policy.json` — knobs for the pre-trade gates, the Dead Man's Switch,
the Master Stop-Loss and the hard circuit breakers.

Strict, fail-closed loading (same rules as risk_limits.json):
  * the file is created with DEFAULTS on first read;
  * unknown keys, wrong types and out-of-range values RAISE PolicyError — callers treat
    that as "locked / refuse", never as "use defaults";
  * a partial file is merged over DEFAULTS, so a new knob added in code gets its default.

The daily loss cap and max concurrent positions are NOT duplicated here: they stay in
risk_limits.json (`max_daily_loss_pct`, `max_concurrent_positions`) and are read from there.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

POLICY_NAME = "risk-policy.json"


class PolicyError(ValueError):
    pass


DEFAULTS: dict[str, Any] = {
    "version": 1,
    "pretrade": {
        # Every source (agent, engines, manual) may only trade these. Empty list = nothing is allowed.
        "allowlist": ["SPY", "QQQ", "IWM", "DIA", "GLD", "SLV", "TLT", "USO", "UNG", "XLE", "XLF", "XLK"],
        "max_shares_per_order": 200,
        "max_notional_per_order_base": 25000.0,
        "max_orders_per_minute": 3,
        "global_cooldown_s": 20,
        "intent_hash_window_s": 900,       # same content (any intent_id) refused inside this window
        "require_take_profit": True,       # stop is already mandatory in the schema; TP completes the bracket
        "options_exempt_from_stop": True,  # options get premium stops from the desk's options guard (no STP on thin prints)
        "max_quote_age_s": 15.0,
        "max_snapshot_age_s": 10.0,
    },
    "dead_mans_switch": {
        "grace_s": 45,                     # clamped to 30..60
        "poll_s": 5,
        "tws_probe_s": 15,
        "on_clean_close": "halt_autonomous",   # halt_autonomous | none
        "cancel_unfilled_entries": True,
        "naked_action": "emergency_stop",      # emergency_stop | liquidate
        "emergency_stop_atr_mult": 1.5,
        "emergency_stop_min_pct": 1.0,         # stop never closer than this % below/above the market
    },
    "master_stop": {
        "bar_size": "1 min",
        "bar_duration": "7200 S",
        "slope_window_bars": 15,
        "rel_volume_window_bars": 30,
        "noise_buffer_atr_mult": 0.5,
        "noise_buffer_min_pct": 0.35,
        "drawdown_full_scale_atr_mult": 2.0,   # drawdown of this many ATRs scores 1.0
        "slope_full_scale_atr_per_bar": 0.08,  # adverse slope of this many ATR per bar scores 1.0
        "rel_volume_full_scale": 3.0,          # relative volume at which the factor saturates
        "vol_expansion_full_scale": 2.0,       # realized/IV (or intraday range/ATR fallback) ratio that saturates
        "weights": {"drawdown": 0.4, "slope": 0.25, "rel_volume": 0.15, "volatility": 0.2},
        "tier1_score": 0.45,
        "tier2_score": 0.7,
        "tier2_confirm_evals": 3,              # consecutive evaluations at or above tier2_score
        "tier1_lock_desk": False,
        "hard_stop_pct": 4.0,                  # per-position loss % that is a confirmed breakdown by itself
        "max_data_age_s": 120.0,               # older market data never escalates to tier 2 (alerts instead)
        "eval_interval_s": 60,
    },
    "circuit_breakers": {
        "daily_loss_action": "lock_cancel_entries",  # lock_cancel_entries | flatten_all
        "rejection_storm_count": 5,
        "rejection_storm_window_s": 300,
        "naked_grace_s": 60,
    },
    "unlock": {
        "reconcile_max_age_s": 120,
    },
}

ENUMS = {
    ("dead_mans_switch", "on_clean_close"): ("halt_autonomous", "none"),
    ("dead_mans_switch", "naked_action"): ("emergency_stop", "liquidate"),
    ("circuit_breakers", "daily_loss_action"): ("lock_cancel_entries", "flatten_all"),
    ("master_stop", "bar_size"): ("1 min", "2 mins", "5 mins"),
}

# (section, key) -> (min, max) inclusive
RANGES: dict[tuple[str, str], tuple[float, float]] = {
    ("pretrade", "max_shares_per_order"): (1, 100_000),
    ("pretrade", "max_notional_per_order_base"): (1, 10_000_000),
    ("pretrade", "max_orders_per_minute"): (1, 60),
    ("pretrade", "global_cooldown_s"): (0, 3600),
    ("pretrade", "intent_hash_window_s"): (0, 86400),
    ("pretrade", "max_quote_age_s"): (1, 3600),
    ("pretrade", "max_snapshot_age_s"): (1, 600),
    ("dead_mans_switch", "grace_s"): (30, 60),
    ("dead_mans_switch", "poll_s"): (1, 30),
    ("dead_mans_switch", "tws_probe_s"): (5, 120),
    ("dead_mans_switch", "emergency_stop_atr_mult"): (0.25, 10),
    ("dead_mans_switch", "emergency_stop_min_pct"): (0.1, 20),
    ("master_stop", "slope_window_bars"): (3, 240),
    ("master_stop", "rel_volume_window_bars"): (3, 390),
    ("master_stop", "noise_buffer_atr_mult"): (0, 10),
    ("master_stop", "noise_buffer_min_pct"): (0, 20),
    ("master_stop", "drawdown_full_scale_atr_mult"): (0.25, 20),
    ("master_stop", "slope_full_scale_atr_per_bar"): (0.001, 5),
    ("master_stop", "rel_volume_full_scale"): (1.1, 50),
    ("master_stop", "vol_expansion_full_scale"): (1.1, 50),
    ("master_stop", "tier1_score"): (0.01, 1),
    ("master_stop", "tier2_score"): (0.01, 1),
    ("master_stop", "tier2_confirm_evals"): (1, 50),
    ("master_stop", "hard_stop_pct"): (0.1, 100),
    ("master_stop", "max_data_age_s"): (5, 3600),
    ("master_stop", "eval_interval_s"): (5, 3600),
    ("circuit_breakers", "rejection_storm_count"): (1, 1000),
    ("circuit_breakers", "rejection_storm_window_s"): (10, 86400),
    ("circuit_breakers", "naked_grace_s"): (5, 3600),
    ("unlock", "reconcile_max_age_s"): (10, 3600),
}


def _merge(base: dict[str, Any], over: dict[str, Any], path: str = "") -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in over.items():
        where = f"{path}{k}"
        if k not in base:
            raise PolicyError(f"{POLICY_NAME}: unknown key {where!r}")
        b = base[k]
        if isinstance(b, dict):
            if not isinstance(v, dict):
                raise PolicyError(f"{POLICY_NAME}: {where} must be an object")
            out[k] = _merge(b, v, where + ".")
        elif isinstance(b, bool):
            if not isinstance(v, bool):
                raise PolicyError(f"{POLICY_NAME}: {where} must be true/false")
            out[k] = v
        elif isinstance(b, (int, float)):
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise PolicyError(f"{POLICY_NAME}: {where} must be a number")
            if isinstance(b, int) and not isinstance(b, bool) and isinstance(v, float) and not v.is_integer():
                raise PolicyError(f"{POLICY_NAME}: {where} must be an integer")
            out[k] = type(b)(v)
        elif isinstance(b, str):
            if not isinstance(v, str):
                raise PolicyError(f"{POLICY_NAME}: {where} must be a string")
            out[k] = v
        elif isinstance(b, list):
            if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
                raise PolicyError(f"{POLICY_NAME}: {where} must be a list of strings")
            out[k] = [x.strip().upper() for x in v]
        else:  # pragma: no cover
            out[k] = v
    return out


def validate(p: dict[str, Any]) -> dict[str, Any]:
    for (sec, key), allowed in ENUMS.items():
        if p[sec][key] not in allowed:
            raise PolicyError(f"{POLICY_NAME}: {sec}.{key} must be one of {', '.join(allowed)}")
    for (sec, key), (lo, hi) in RANGES.items():
        v = p[sec][key]
        if not lo <= v <= hi:
            raise PolicyError(f"{POLICY_NAME}: {sec}.{key}={v} outside [{lo}, {hi}]")
    ms = p["master_stop"]
    if ms["tier1_score"] >= ms["tier2_score"]:
        raise PolicyError(f"{POLICY_NAME}: master_stop.tier1_score must be below tier2_score")
    if ms["noise_buffer_min_pct"] >= ms["hard_stop_pct"]:
        raise PolicyError(f"{POLICY_NAME}: master_stop.noise_buffer_min_pct must be below hard_stop_pct (else the hard stop can never fire)")
    w = ms["weights"]
    if any(x < 0 for x in w.values()) or abs(sum(w.values()) - 1.0) > 1e-6:
        raise PolicyError(f"{POLICY_NAME}: master_stop.weights must be >= 0 and sum to 1.0 (got {sum(w.values()):.3f})")
    if p["version"] != 1:
        raise PolicyError(f"{POLICY_NAME}: unsupported version {p['version']}")
    for s in p["pretrade"]["allowlist"]:
        if not s or len(s) > 10 or not s.replace(".", "").isalnum():
            raise PolicyError(f"{POLICY_NAME}: allowlist entry {s!r} is not a ticker")
    return p


def defaults() -> dict[str, Any]:
    return copy.deepcopy(DEFAULTS)


def load_policy(path: Path) -> dict[str, Any]:
    """Read (or create with defaults) and validate. Raises PolicyError on anything malformed."""
    path = Path(path)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(DEFAULTS, indent=2), encoding="utf-8")
        tmp.replace(path)
        return validate(defaults())
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise PolicyError(f"{POLICY_NAME}: unreadable ({e})") from None
    if not isinstance(raw, dict):
        raise PolicyError(f"{POLICY_NAME}: must be a JSON object")
    return validate(_merge(DEFAULTS, raw))


def policy_path(d: Path) -> Path:
    return Path(d) / POLICY_NAME
