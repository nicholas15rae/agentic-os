"""OrderIntent — the ONLY thing the Trading Agent (or an engine) may hand to execution.

The agent never talks to the IBKR socket. It emits an `OrderIntent` JSON object;
`parse_intent()` validates it strictly (unknown fields are refused, every entry
needs a hard stop), then the Security Detail decides, then the executor acts.

Risk limits live in `data/trading/risk_limits.json` (created with the defaults
below on first read). The Financer's budget envelope can only tighten them
(see comms.py), never loosen.
"""

from __future__ import annotations

import json
import math
import re
import time
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

# STK: shares/ETFs (Engine A). OPT: one long option. BAG: a debit vertical (two legs).
# Futures (FUT) stay out until Engine A's resolver is switched on with its own caps.
SEC_TYPES = ("STK", "OPT", "BAG")
OPTION_SEC_TYPES = ("OPT", "BAG")
ASSET_CLASSES = ("equity", "etf", "commodity_etf", "option")
RIGHTS = ("C", "P")
EXPIRY_RE = re.compile(r"^20\d{6}$")
OPTION_MULTIPLIER = 100
ACTIONS = ("BUY", "SELL")
ORDER_TYPES = ("MKT", "LMT")
TIFS = ("DAY", "GTC")
SOURCES = ("trading_agent", "engine_a", "engine_b", "manual")
SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


class IntentError(ValueError):
    pass


@dataclass(frozen=True)
class OrderIntent:
    intent_id: str
    source: str
    asset_class: str
    symbol: str
    action: str
    quantity: int
    order_type: str
    stop_loss: float
    sec_type: str = "STK"
    exchange: str = "SMART"
    currency: str = "USD"
    limit_price: float | None = None
    take_profit: float | None = None
    time_in_force: str = "DAY"
    thesis: str = ""
    citations: tuple[str, ...] = ()
    created_at: float = 0.0
    # Options only: [{action, right, strike, expiry}] — 1 leg (OPT) or 2 legs (BAG debit vertical).
    # Prices (limit / stop / take-profit) are then PER-CONTRACT premium; quantity is contracts.
    legs: tuple[dict[str, Any], ...] = ()
    multiplier: int = 1

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["citations"] = list(self.citations)
        d["legs"] = [dict(x) for x in self.legs]
        return d

    @property
    def is_option(self) -> bool:
        return self.sec_type in OPTION_SEC_TYPES

    @property
    def expiry(self) -> str | None:
        return self.legs[0]["expiry"] if self.legs else None

    @property
    def is_long(self) -> bool:
        return self.action == "BUY"


INTENT_FIELDS = {f.name for f in fields(OrderIntent)}
REQUIRED = {"intent_id", "source", "asset_class", "symbol", "action", "quantity", "order_type", "stop_loss"}


def _price(v: Any, name: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0:
        raise IntentError(f"{name} must be a positive number")
    return float(v)


def parse_intent(raw: Any) -> OrderIntent:
    """Strict parse. Raises IntentError with a precise reason; never guesses or coerces silently."""
    if not isinstance(raw, dict):
        raise IntentError("intent must be a JSON object")
    unknown = set(raw) - INTENT_FIELDS
    if unknown:
        raise IntentError(f"unknown field(s): {sorted(unknown)}")
    missing = REQUIRED - set(raw)
    if missing:
        raise IntentError(f"missing field(s): {sorted(missing)}")

    iid = str(raw["intent_id"])
    if not ID_RE.match(iid):
        raise IntentError("intent_id: 8-64 letters, digits, _ or -")

    def one_of(key: str, allowed: tuple[str, ...], default: str | None = None) -> str:
        v = raw.get(key, default)
        if v not in allowed:
            raise IntentError(f"{key} must be one of {', '.join(allowed)} (got {v!r})")
        return v

    source = one_of("source", SOURCES)
    asset_class = one_of("asset_class", ASSET_CLASSES)
    sec_type = one_of("sec_type", SEC_TYPES, "STK")
    action = one_of("action", ACTIONS)
    order_type = one_of("order_type", ORDER_TYPES)
    tif = one_of("time_in_force", TIFS, "DAY")

    symbol = str(raw["symbol"]).strip().upper()
    if not SYMBOL_RE.match(symbol):
        raise IntentError(f"symbol {raw['symbol']!r} is not a valid ticker")
    currency = str(raw.get("currency", "USD")).upper()
    if not CURRENCY_RE.match(currency):
        raise IntentError("currency must be a 3-letter code")
    exchange = str(raw.get("exchange", "SMART")).upper()
    if exchange != "SMART":
        raise IntentError("exchange must be SMART")

    qty = raw["quantity"]
    if isinstance(qty, bool) or not isinstance(qty, int) or qty <= 0:
        raise IntentError("quantity must be a positive integer")

    stop = _price(raw["stop_loss"], "stop_loss")
    limit = None
    if order_type == "LMT":
        if raw.get("limit_price") is None:
            raise IntentError("LMT orders need limit_price")
        limit = _price(raw["limit_price"], "limit_price")
    elif raw.get("limit_price") is not None:
        raise IntentError("MKT orders must not carry limit_price")
    tp = None if raw.get("take_profit") is None else _price(raw["take_profit"], "take_profit")

    # Stop / target must sit on the right side of the entry.
    if limit is not None:
        if action == "BUY" and not (stop < limit and (tp is None or tp > limit)):
            raise IntentError("BUY needs stop_loss < limit_price < take_profit")
        if action == "SELL" and not (stop > limit and (tp is None or tp < limit)):
            raise IntentError("SELL needs take_profit < limit_price < stop_loss")
    elif tp is not None and ((action == "BUY" and tp <= stop) or (action == "SELL" and tp >= stop)):
        raise IntentError("take_profit is on the wrong side of stop_loss")

    legs, multiplier = _parse_legs(raw, sec_type, asset_class, action, order_type)

    thesis = str(raw.get("thesis", ""))
    if len(thesis) > 4000:
        raise IntentError("thesis: at most 4000 characters")
    cites = raw.get("citations", [])
    if not isinstance(cites, list) or len(cites) > 20 or not all(isinstance(c, str) and len(c) <= 300 for c in cites):
        raise IntentError("citations: up to 20 strings of at most 300 characters")

    return OrderIntent(
        intent_id=iid, source=source, asset_class=asset_class, symbol=symbol, action=action,
        quantity=qty, order_type=order_type, stop_loss=stop, sec_type=sec_type, exchange=exchange,
        currency=currency, limit_price=limit, take_profit=tp, time_in_force=tif, thesis=thesis,
        citations=tuple(cites), created_at=float(raw.get("created_at") or time.time()),
        legs=legs, multiplier=multiplier,
    )


def _parse_legs(raw: dict[str, Any], sec_type: str, asset_class: str, action: str, order_type: str) -> tuple[tuple[dict[str, Any], ...], int]:
    """Defined-risk option structures only. Stocks must not carry legs."""
    raw_legs = raw.get("legs")
    if sec_type == "STK":
        if raw_legs:
            raise IntentError("legs are only for options (sec_type OPT / BAG)")
        if asset_class == "option":
            raise IntentError("asset_class option needs sec_type OPT or BAG")
        if raw.get("multiplier", 1) != 1:
            raise IntentError("stocks have multiplier 1")
        return (), 1
    if asset_class != "option":
        raise IntentError("options need asset_class option")
    if action != "BUY":
        raise IntentError("options: only BUY (long option / debit vertical) — no naked or credit structures")
    if order_type != "LMT":
        raise IntentError("options: limit orders only")
    if raw.get("multiplier", OPTION_MULTIPLIER) != OPTION_MULTIPLIER:
        raise IntentError(f"options: multiplier must be {OPTION_MULTIPLIER}")
    want = 1 if sec_type == "OPT" else 2
    if not isinstance(raw_legs, list) or len(raw_legs) != want:
        raise IntentError(f"{sec_type} needs exactly {want} leg(s)")
    legs = []
    for i, leg in enumerate(raw_legs):
        if not isinstance(leg, dict) or set(leg) != {"action", "right", "strike", "expiry"}:
            raise IntentError(f"leg {i}: exactly action, right, strike, expiry")
        if leg["action"] not in ACTIONS or leg["right"] not in RIGHTS:
            raise IntentError(f"leg {i}: action BUY/SELL, right C/P")
        if not isinstance(leg["expiry"], str) or not EXPIRY_RE.match(leg["expiry"]):
            raise IntentError(f"leg {i}: expiry YYYYMMDD")
        legs.append({"action": leg["action"], "right": leg["right"], "strike": _price(leg["strike"], f"leg {i} strike"), "expiry": leg["expiry"]})
    if sec_type == "OPT":
        if legs[0]["action"] != "BUY":
            raise IntentError("single-leg options must be bought (no naked shorts)")
    else:
        a, b = legs
        if {a["action"], b["action"]} != {"BUY", "SELL"}:
            raise IntentError("vertical: one BUY leg and one SELL leg")
        if a["right"] != b["right"] or a["expiry"] != b["expiry"] or a["strike"] == b["strike"]:
            raise IntentError("vertical: same right and expiry, different strikes")
        long_leg = a if a["action"] == "BUY" else b
        short_leg = b if long_leg is a else a
        nearer = long_leg["strike"] < short_leg["strike"] if long_leg["right"] == "C" else long_leg["strike"] > short_leg["strike"]
        if not nearer:
            raise IntentError("vertical must be a DEBIT spread (long leg nearer the money)")
        legs = [long_leg, short_leg]
    return tuple(legs), OPTION_MULTIPLIER


# ── Risk limits ──────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class RiskLimits:
    max_risk_per_trade_pct: float = 0.5       # % of equity lost if the stop is hit
    max_risk_per_trade_base: float = 2500.0   # same, absolute cap in account base currency
    max_position_pct: float = 10.0            # notional of one order, % of equity
    max_gross_exposure_pct: float = 50.0      # all positions + working orders, % of equity
    max_concurrent_positions: int = 5
    max_daily_loss_pct: float = 2.5           # trips the kill switch
    max_spread_pct: float = 0.25              # (ask-bid)/mid, %
    max_price_drift_pct: float = 1.5          # LMT/MKT entry vs. current mid, %
    min_avg_daily_volume: int = 300_000       # 20-day average shares/day (illiquidity filter)
    min_avg_dollar_volume_base: float = 10_000_000.0  # 20-day average traded value/day, base currency
    max_volatility_pct: float = 60.0          # 20-day realized volatility, annualized %
    max_atr_pct: float = 6.0                  # 14-day average true range, % of last close
    require_corroboration: bool = True        # an intent citing external hypotheses must also cite telemetry
    allow_extended_hours: bool = False
    symbol_cooldown_s: int = 300
    duplicate_window_s: int = 120
    max_orders_per_day: int = 20
    approval_ttl_s: int = 600                 # SEMI_AUTO cards expire (stale prices)
    financer_allocation_base: float | None = None  # Financer's capital envelope; caps equity used for sizing

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


LIMIT_FIELDS = {f.name: f for f in fields(RiskLimits)}


def load_limits(path: Path) -> RiskLimits:
    """Read limits; create the file with defaults if absent. A corrupt file fails closed (raises)."""
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(RiskLimits().to_dict(), indent=2), encoding="utf-8")
        return RiskLimits()
    data = json.loads(path.read_text(encoding="utf-8"))
    unknown = set(data) - set(LIMIT_FIELDS)
    if unknown:
        raise ValueError(f"risk_limits.json: unknown field(s) {sorted(unknown)}")
    lim = RiskLimits(**data)
    for name in ("max_risk_per_trade_pct", "max_position_pct", "max_gross_exposure_pct", "max_daily_loss_pct", "max_spread_pct"):
        v = getattr(lim, name)
        if not isinstance(v, (int, float)) or not 0 < v <= 100:
            raise ValueError(f"risk_limits.json: {name} must be in (0, 100]")
    for name in ("max_volatility_pct", "max_atr_pct"):
        v = getattr(lim, name)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 < v <= 1000:
            raise ValueError(f"risk_limits.json: {name} must be in (0, 1000]")
    for name in ("min_avg_daily_volume", "min_avg_dollar_volume_base"):
        v = getattr(lim, name)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0:
            raise ValueError(f"risk_limits.json: {name} must be >= 0")
    return lim
