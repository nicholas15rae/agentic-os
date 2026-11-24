"""Quiver Quantitative ingestion — political and insider trading disclosures → trading_rag.

Pipeline (one batch):

  fetch  GET https://api.quiverquant.com/beta/live/{congresstrading,insiders}
         (Bearer token from QUIVER_API_TOKEN; fixed host, HTTPS only, size-capped)
  parse  each raw row → a `Disclosure` (structured JSON): who, role/chamber, party,
         ticker, buy/sell, transaction size (low/high USD), shares, trade date, filing date
  filter invalid tickers, non-stock rows and filings older than QUIVER_MAX_AGE_DAYS dropped
  store  new disclosures appended to data/trading/quiver/disclosures/YYYY-MM-DD.jsonl and
         put into the trading_rag vault tagged class:external_signal_hypothesis

Nothing here can place, size or approve an order. A disclosure is context for
the Trading Agent; anything it proposes is an OrderIntent that still has to pass
the Security Detail (liquidity, spread, volatility, drawdown, sizing) and, for
an intent that cites only hypotheses, is rejected outright (`signal_provenance`).

Run once:          python quiver.py --once
Run continuously:  the bridge starts `poll_forever()` when QUIVER_API_TOKEN is set
                   (every QUIVER_POLL_MINUTES, default 60).
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from config import REPO_ROOT, _read_dotenv, data_dir
from intents import SYMBOL_RE
from trading_rag import EXTERNAL_SIGNAL_HYPOTHESIS, TradingRag

log = logging.getLogger("trading.quiver")

API_HOST = "https://api.quiverquant.com"
ENDPOINTS = {"congress": "/beta/live/congresstrading", "insider": "/beta/live/insiders"}
MAX_BYTES = 25 * 1024 * 1024
TIMEOUT_S = 30
DEFAULT_POLL_MIN = 60
DEFAULT_MAX_AGE_DAYS = 60

Fetcher = Callable[[str, str], Any]  # (path, token) -> parsed JSON


class QuiverError(RuntimeError):
    pass


def setting(name: str, default: str = "") -> str:
    return os.environ.get(name) or _read_dotenv(REPO_ROOT / ".env").get(name, default)


def token() -> str:
    return setting("QUIVER_API_TOKEN").strip()


def http_fetch(path: str, tok: str) -> Any:
    if path not in ENDPOINTS.values():
        raise QuiverError(f"unknown endpoint {path}")
    req = urllib.request.Request(API_HOST + path, headers={
        "Authorization": f"Bearer {tok}", "Accept": "application/json", "User-Agent": "trading-desk/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:  # noqa: S310 — fixed https host
            body = r.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        raise QuiverError(f"HTTP {e.code} from {path}" + (" (check QUIVER_API_TOKEN / plan)" if e.code in (401, 403) else "")) from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise QuiverError(f"network error for {path}: {e}") from None
    if len(body) > MAX_BYTES:
        raise QuiverError(f"{path}: response over {MAX_BYTES} bytes")
    try:
        return json.loads(body.decode("utf-8"))
    except ValueError:
        raise QuiverError(f"{path}: response is not JSON") from None


# ── parsing ──────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Disclosure:
    id: str
    kind: str                 # congress | insider
    actor: str                # politician / insider name
    role: str                 # "House", "Senate", or the insider's title / relationship
    party: str                # congress only ("" for insiders)
    ticker: str
    transaction: str          # buy | sell | other
    size_low_usd: float | None
    size_high_usd: float | None
    shares: float | None
    traded_date: str          # YYYY-MM-DD ("" if unknown)
    filed_date: str           # YYYY-MM-DD
    raw_transaction: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def size_label(self) -> str:
        lo, hi = self.size_low_usd, self.size_high_usd
        if lo is None and hi is None:
            return "size n/a"
        if hi is None:
            return f"${lo:,.0f}+"
        if lo is None or lo == hi:
            return f"${hi:,.0f}"
        return f"${lo:,.0f}–${hi:,.0f}"

    def summary(self) -> str:
        who = f"{self.actor} ({self.party[:1] + '-' if self.party else ''}{self.role})" if self.role else self.actor
        when = f"traded {self.traded_date or '?'}, filed {self.filed_date}"
        lag = ""
        if self.traded_date and self.filed_date:
            try:
                lag = f" ({(date.fromisoformat(self.filed_date) - date.fromisoformat(self.traded_date)).days}d disclosure lag)"
            except ValueError:
                pass
        kind = "Congressional" if self.kind == "congress" else "Insider (Form 4)"
        return f"{kind} disclosure: {who} {self.transaction.upper()} {self.ticker}, {self.size_label()}; {when}{lag}."


def _first(row: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        v = row.get(k)
        if v not in (None, "", "N/A", "nan"):
            return v
    return None


def _num(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        x = float(str(v).replace(",", "").replace("$", "").strip())
    except ValueError:
        return None
    return x if x == x and x >= 0 else None  # NaN / negative → unknown


def _date(v: Any) -> str:
    if v is None:
        return ""
    s = str(v).strip()
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y"):
        try:
            return datetime.strptime(s[:19] if "T" in s or " " in s else s, fmt).date().isoformat()
        except ValueError:
            continue
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", s)
    return m.group(1) if m else ""


_MONEY = re.compile(r"\$?\s*([\d,]+(?:\.\d+)?)")


def parse_range(rng: Any) -> tuple[float | None, float | None]:
    """'$1,001 - $15,000' → (1001, 15000); 'Over $50,000,000' → (50e6, None); '$15,000' → (15000, 15000)."""
    if rng is None:
        return None, None
    s = str(rng)
    nums = [float(n.replace(",", "")) for n in _MONEY.findall(s)]
    if not nums:
        return None, None
    if re.search(r"\bover\b|\+|or more", s, re.I):
        return nums[0], None
    if len(nums) >= 2:
        return min(nums[0], nums[1]), max(nums[0], nums[1])
    return nums[0], nums[0]


def _txn(raw: str, kind: str) -> str:
    r = raw.strip().lower()
    if kind == "insider":
        code = r[:1]
        return {"p": "buy", "s": "sell"}.get(code, "other")
    if r.startswith(("purchase", "buy")):
        return "buy"
    if r.startswith(("sale", "sell")):
        return "sell"
    return "other"


def _make_id(*parts: Any) -> str:
    return hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:20]


def normalize_congress(row: Any) -> Disclosure | None:
    if not isinstance(row, dict):
        return None
    ticker = str(_first(row, "Ticker", "ticker") or "").strip().upper()
    ttype = str(_first(row, "TickerType", "AssetType") or "Stock")
    if not SYMBOL_RE.match(ticker) or ttype.lower() not in ("stock", "st", "etf"):
        return None
    actor = str(_first(row, "Representative", "Name", "Senator") or "").strip()
    filed = _date(_first(row, "ReportDate", "DisclosureDate", "Filed"))
    if not actor or not filed:
        return None
    raw_txn = str(_first(row, "Transaction", "Type") or "")
    lo, hi = parse_range(_first(row, "Range"))
    if lo is None and hi is None:
        amt = _num(_first(row, "Amount"))
        lo = hi = amt
    traded = _date(_first(row, "TransactionDate", "Traded"))
    role = str(_first(row, "House", "Chamber") or "").strip()
    party = str(_first(row, "Party") or "").strip()
    return Disclosure(
        id=_make_id("congress", actor, ticker, traded, filed, raw_txn, lo, hi),
        kind="congress", actor=actor[:120], role=role[:40], party=party[:30], ticker=ticker,
        transaction=_txn(raw_txn, "congress"), size_low_usd=lo, size_high_usd=hi, shares=None,
        traded_date=traded, filed_date=filed, raw_transaction=raw_txn[:60],
    )


def normalize_insider(row: Any) -> Disclosure | None:
    if not isinstance(row, dict):
        return None
    ticker = str(_first(row, "Ticker", "ticker") or "").strip().upper()
    if not SYMBOL_RE.match(ticker):
        return None
    actor = str(_first(row, "Name", "InsiderName", "ReportingOwner") or "").strip()
    filed = _date(_first(row, "fileDate", "FileDate", "FilingDate", "Date"))
    if not actor or not filed:
        return None
    code = str(_first(row, "TransactionCode", "Code") or "")
    ad = str(_first(row, "AcquiredDisposedCode") or "")
    shares = _num(_first(row, "Shares", "SharesTraded"))
    price = _num(_first(row, "PricePerShare", "Price"))
    value = shares * price if shares is not None and price is not None else _num(_first(row, "Value"))
    traded = _date(_first(row, "Date", "TransactionDate"))
    role = str(_first(row, "officerTitle", "OfficerTitle", "Title", "Relationship") or "insider").strip()
    return Disclosure(
        id=_make_id("insider", actor, ticker, traded, filed, code, ad, shares, price),
        kind="insider", actor=actor[:120], role=role[:60], party="", ticker=ticker,
        transaction=_txn(code, "insider"), size_low_usd=value, size_high_usd=value, shares=shares,
        traded_date=traded, filed_date=filed, raw_transaction=f"{code}/{ad}".strip("/")[:60],
    )


NORMALIZERS = {"congress": normalize_congress, "insider": normalize_insider}


def parse_batch(kind: str, payload: Any, *, today: date, max_age_days: int) -> list[Disclosure]:
    rows = payload if isinstance(payload, list) else (payload.get("data") if isinstance(payload, dict) else None)
    if not isinstance(rows, list):
        raise QuiverError(f"{kind}: expected a JSON array")
    out: list[Disclosure] = []
    seen: set[str] = set()
    for row in rows:
        d = NORMALIZERS[kind](row)
        if d is None or d.id in seen:
            continue
        try:
            if (today - date.fromisoformat(d.filed_date)).days > max_age_days:
                continue
        except ValueError:
            continue
        seen.add(d.id)
        out.append(d)
    return out


def rag_tags(d: Disclosure) -> list[str]:
    tags = [f"class:{EXTERNAL_SIGNAL_HYPOTHESIS}", "source:quiver", f"kind:{d.kind}", f"ticker:{d.ticker}",
            f"side:{d.transaction}", f"filed:{d.filed_date}"]
    if d.party:
        tags.append("party:" + re.sub(r"[^A-Za-z0-9_.\-]", "_", d.party)[:30])
    return tags


# ── ingest ───────────────────────────────────────────────────────────────
def ingest(rag: TradingRag, *, fetch: Fetcher = http_fetch, tok: str | None = None, d: Path | None = None,
           kinds: Iterable[str] = ("congress", "insider"), now: float | None = None,
           max_age_days: int | None = None) -> dict[str, Any]:
    """One batch. Returns a report; per-endpoint errors are recorded, not raised (one feed down ≠ both)."""
    tok = token() if tok is None else tok
    if not tok:
        raise QuiverError("QUIVER_API_TOKEN is not set")
    d = d or data_dir()
    qdir = d / "quiver"
    (qdir / "disclosures").mkdir(parents=True, exist_ok=True)
    now = time.time() if now is None else now
    today = datetime.fromtimestamp(now, timezone.utc).date()
    max_age = max_age_days if max_age_days is not None else int(setting("QUIVER_MAX_AGE_DAYS", str(DEFAULT_MAX_AGE_DAYS)) or DEFAULT_MAX_AGE_DAYS)
    report: dict[str, Any] = {"at": now, "feeds": {}, "new": 0}
    new_rows: list[dict[str, Any]] = []
    for kind in kinds:
        try:
            parsed = parse_batch(kind, fetch(ENDPOINTS[kind], tok), today=today, max_age_days=max_age)
        except QuiverError as e:
            report["feeds"][kind] = {"ok": False, "error": str(e)}
            log.warning("quiver %s: %s", kind, e)
            continue
        added = 0
        for disc in parsed:
            if rag.put(disc.summary(), rag_tags(disc), entry_id=disc.id, now_ms=int(now * 1000)) is not None:
                added += 1
                new_rows.append({**disc.to_dict(), "signal_class": EXTERNAL_SIGNAL_HYPOTHESIS, "ingested_at": now})
        report["feeds"][kind] = {"ok": True, "parsed": len(parsed), "new": added}
        report["new"] += added
    if new_rows:
        with open(qdir / "disclosures" / f"{today.isoformat()}.jsonl", "a", encoding="utf-8") as f:
            for r in new_rows:
                f.write(json.dumps(r, sort_keys=True) + "\n")
    report["ok"] = any(f.get("ok") for f in report["feeds"].values())
    tmp = qdir / "state.json.tmp"
    tmp.write_text(json.dumps(report, indent=2), encoding="utf-8")
    tmp.replace(qdir / "state.json")
    return report


def last_report(d: Path | None = None) -> dict[str, Any] | None:
    try:
        return json.loads(((d or data_dir()) / "quiver" / "state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


async def poll_forever(rag: TradingRag, *, interval_s: float | None = None) -> None:
    if interval_s is None:
        try:
            interval_s = max(5.0, float(setting("QUIVER_POLL_MINUTES", str(DEFAULT_POLL_MIN)))) * 60
        except ValueError:
            interval_s = DEFAULT_POLL_MIN * 60
    while True:
        try:
            rep = await asyncio.to_thread(ingest, rag)
            log.info("quiver: %d new disclosures", rep["new"])
        except Exception as e:  # noqa: BLE001 — the poller must never take the bridge down
            log.warning("quiver ingest failed: %s", e)
        await asyncio.sleep(interval_s)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--once", action="store_true", help="run one batch and print the report")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    rag = TradingRag(data_dir() / "trading_rag")
    if args.once:
        try:
            print(json.dumps(ingest(rag), indent=2))
        except QuiverError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        return 0
    asyncio.run(poll_forever(rag))
    return 0


if __name__ == "__main__":
    sys.exit(main())
