"""Pure functions that turn ib_async objects into the JSON the Command Center HUD reads.

No network, no ib_async import: everything is duck-typed so tests can pass
plain fakes. NaN (IBKR's "no value yet") becomes None so the JSON is valid.
"""

from __future__ import annotations

import math
from typing import Any, Iterable

ACCOUNT_TAGS = {
    "NetLiquidation": "netLiquidation",
    "BuyingPower": "buyingPower",
    "AvailableFunds": "availableFunds",
    "TotalCashValue": "totalCash",
    "GrossPositionValue": "grossPositionValue",
}


def num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    # IBKR marks "unset" doubles with sys.float_info.max (UNSET_DOUBLE).
    return None if math.isnan(f) or math.isinf(f) or abs(f) >= 1e300 else f


def account_block(values: Iterable[Any], account: str) -> dict[str, Any]:
    """Pick the per-account, base-currency rows (skips the synthetic 'BASE' rows)."""
    out: dict[str, Any] = {"account": account, "currency": None}
    for v in values:
        key = ACCOUNT_TAGS.get(getattr(v, "tag", ""))
        if not key or getattr(v, "account", account) != account:
            continue
        if getattr(v, "modelCode", "") or getattr(v, "currency", "") in ("", "BASE"):
            continue
        if key not in out:
            out[key] = num(v.value)
            out["currency"] = out["currency"] or v.currency
    for key in ACCOUNT_TAGS.values():
        out.setdefault(key, None)
    return out


def pnl_block(pnl: Any) -> dict[str, float | None]:
    if pnl is None:
        return {"daily": None, "unrealized": None, "realized": None}
    return {
        "daily": num(getattr(pnl, "dailyPnL", None)),
        "unrealized": num(getattr(pnl, "unrealizedPnL", None)),
        "realized": num(getattr(pnl, "realizedPnL", None)),
    }


def _contract(c: Any) -> dict[str, Any]:
    return {
        "symbol": getattr(c, "localSymbol", "") or getattr(c, "symbol", ""),
        "underlying": getattr(c, "symbol", ""),
        "secType": getattr(c, "secType", ""),
        "currency": getattr(c, "currency", ""),
        "conId": getattr(c, "conId", 0),
    }


def positions_block(portfolio: Iterable[Any]) -> list[dict[str, Any]]:
    rows = []
    for p in portfolio:
        if not num(getattr(p, "position", 0)):
            continue
        rows.append(
            {
                **_contract(p.contract),
                "position": num(p.position),
                "avgCost": num(getattr(p, "averageCost", None)),
                "marketPrice": num(getattr(p, "marketPrice", None)),
                "marketValue": num(getattr(p, "marketValue", None)),
                "unrealizedPnl": num(getattr(p, "unrealizedPNL", None)),
                "realizedPnl": num(getattr(p, "realizedPNL", None)),
            }
        )
    rows.sort(key=lambda r: -abs(r["marketValue"] or 0))
    return rows


DONE_STATUSES = {"Filled", "Cancelled", "ApiCancelled", "Inactive"}


def orders_block(trades: Iterable[Any]) -> list[dict[str, Any]]:
    rows = []
    for t in trades:
        st = getattr(t, "orderStatus", None)
        status = getattr(st, "status", "") if st else ""
        if status in DONE_STATUSES:
            continue
        o = t.order
        rows.append(
            {
                **_contract(t.contract),
                "orderId": getattr(o, "orderId", 0),
                "permId": getattr(o, "permId", 0),
                "clientId": getattr(o, "clientId", 0),
                "action": getattr(o, "action", ""),
                "quantity": num(getattr(o, "totalQuantity", None)),
                "orderType": getattr(o, "orderType", ""),
                "limitPrice": num(getattr(o, "lmtPrice", None)) or None,
                "stopPrice": num(getattr(o, "auxPrice", None)) or None,
                "tif": getattr(o, "tif", ""),
                "status": status,
                "filled": num(getattr(st, "filled", None)) if st else None,
                "remaining": num(getattr(st, "remaining", None)) if st else None,
            }
        )
    return rows
