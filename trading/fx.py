"""FX rates for sizing USD instruments in a non-USD (e.g. CAD) account.

Priority: IBKR's own `ExchangeRate` account rows (live, from the bridge
snapshot) → Bank of Canada daily average (public Valet API, no key, nothing
about the user is sent) with a safety margin → nothing (the Security Detail
then fails closed). The paper account has no IDEALPRO permissions, so IBKR
can't quote USD.CAD itself.

The margin makes a stale daily rate overstate risk: base-currency risk and
exposure computed with `rate * (1 + SAFETY_MARGIN)` are slightly larger than
reality, never smaller.
"""

from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path
from typing import Callable

VALET = "https://www.bankofcanada.ca/valet/observations/{series}/json?recent=1"
SAFETY_MARGIN = 0.01
TTL_S = 6 * 3600
MAX_AGE_DAYS = 5  # BoC publishes business days; older than this = treat as missing


def _valet(series: str, timeout: float = 6.0) -> tuple[float, str] | None:
    req = urllib.request.Request(VALET.format(series=series), headers={"User-Agent": "trading-bridge/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — fixed https URL
        data = json.loads(r.read().decode("utf-8"))
    obs = data.get("observations") or []
    if not obs:
        return None
    row = obs[-1]
    v = (row.get(series) or {}).get("v")
    return (float(v), row.get("d", "")) if v else None


class FxSource:
    def __init__(self, cache_path: Path, fetch: Callable[[str], tuple[float, str] | None] = _valet, clock: Callable[[], float] = time.time) -> None:
        self.cache_path = cache_path
        self.fetch = fetch
        self.clock = clock
        try:
            self.cache: dict[str, dict] = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.cache = {}

    def _cad_per(self, cur: str) -> float | None:
        if cur == "CAD":
            return 1.0
        series = f"FX{cur}CAD"
        hit = self.cache.get(series)
        if hit and self.clock() - hit["fetched"] < TTL_S:
            return hit["rate"]
        try:
            got = self.fetch(series)
        except Exception:  # noqa: BLE001 — offline: fall back to a not-too-old cached value
            got = None
        if got:
            rate, day = got
            self.cache[series] = {"rate": rate, "date": day, "fetched": self.clock()}
            try:
                self.cache_path.write_text(json.dumps(self.cache, indent=2), encoding="utf-8")
            except OSError:
                pass
            return rate
        if hit and self.clock() - hit["fetched"] < MAX_AGE_DAYS * 86400:
            return hit["rate"]
        return None

    def rate_to_base(self, cur: str, base: str) -> float | None:
        """Units of `base` per 1 `cur`, padded by SAFETY_MARGIN. None if unknown."""
        if cur == base:
            return 1.0
        a, b = self._cad_per(cur), self._cad_per(base)
        if not a or not b:
            return None
        return a / b * (1 + SAFETY_MARGIN)


def merged_rates(ibkr: dict[str, float], needed: set[str], base: str | None, source: FxSource | None) -> tuple[dict[str, float], dict[str, str]]:
    """IBKR rows first; fill gaps from `source`. Returns (rates, provenance per currency)."""
    rates = dict(ibkr)
    prov = {c: "ibkr" for c in ibkr}
    if not base or source is None:
        return rates, prov
    for cur in sorted(needed - set(rates) - {base}):
        r = source.rate_to_base(cur, base)
        if r:
            rates[cur] = r
            prov[cur] = f"bank_of_canada(+{SAFETY_MARGIN:.0%})"
    return rates, prov
