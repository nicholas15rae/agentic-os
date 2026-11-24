"""Quantgress ingestion — congressional and insider trading disclosures → trading_rag.

Quantgress (github.com/DMulajkar/Quantgress) is a self-hosted,
open-source alternative to Quiver Quantitative: it scrapes Senate/House PTRs
and SEC Form 4 filings from the primary government sources into DuckDB and
serves them over a read-only FastAPI. Run it locally (`uvicorn api:app`) and
point this module at it; nothing here talks to a paid or third-party API.

Pipeline (one batch):

  fetch  GET {QUANTGRESS_URL}/trades and /insiders (x-api-key: QUANTGRESS_API_KEY),
         paged with ?limit=1000&offset=…; loopback hosts only, size-capped
  parse  each row → a `Disclosure` (structured JSON): who, chamber/relationship, ticker,
         buy/sell, transaction size (low/high USD), shares, trade date, filing date,
         plus provenance flags (ticker inferred from free text, 10b5-1 planned sale)
  filter invalid tickers, non-stock rows and filings older than QUANTGRESS_MAX_AGE_DAYS dropped
  store  new disclosures appended to data/trading/quantgress/disclosures/YYYY-MM-DD.jsonl
         and put into the trading_rag vault tagged class:external_signal_hypothesis

Signals key off `filed_date` (when the public could first know), never the trade
date — using the trade date bakes in look-ahead bias.

Nothing here can place, size or approve an order. A disclosure is context for
the Trading Agent; anything it proposes is an OrderIntent that still has to pass
the Security Detail (liquidity, spread, volume, volatility, drawdown, sizing) and,
for an intent that cites only hypotheses, is rejected outright (`signal_provenance`).

Run once:          python quantgress.py --once
Run continuously:  the bridge starts `poll_forever()` when QUANTGRESS_API_KEY is set
                   (every QUANTGRESS_POLL_MINUTES, default 60).
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
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from config import LOOPBACK_HOSTS, REPO_ROOT, _read_dotenv, data_dir
from intents import SYMBOL_RE
from trading_rag import EXTERNAL_SIGNAL_HYPOTHESIS, TradingRag

log = logging.getLogger("trading.quantgress")

DEFAULT_URL = "http://127.0.0.1:8000"
ENDPOINTS = {"congress": "/trades", "insider": "/insiders"}
PAGE = 1000          # Quantgress MAX_LIMIT
MAX_PAGES = 10
MAX_BYTES = 25 * 1024 * 1024
TIMEOUT_S = 30
DEFAULT_POLL_MIN = 60
DEFAULT_MAX_AGE_DAYS = 60
# Rows come newest-trade-first; a filing can trail its trade by 45+ days, so keep
# paging until trade dates are well past the filing-date cutoff.
LATE_FILING_SLACK_DAYS = 120

Fetcher = Callable[[str, dict[str, Any], str], Any]  # (path, params, api_key) -> parsed JSON


class QuantgressError(RuntimeError):
    pass


def setting(name: str, default: str = "") -> str:
    return os.environ.get(name) or _read_dotenv(REPO_ROOT / ".env").get(name, default)


def api_key() -> str:
    return setting("QUANTGRESS_API_KEY").strip()


def base_url() -> str:
    """QUANTGRESS_URL, validated: http(s) on a loopback host only (it's a local, self-hosted service)."""
    url = (setting("QUANTGRESS_URL", DEFAULT_URL) or DEFAULT_URL).strip().rstrip("/")
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https") or (u.hostname or "") not in LOOPBACK_HOSTS or u.path not in ("", "/"):
        raise QuantgressError(f"QUANTGRESS_URL must be http(s)://<loopback>:<port>, got {url!r}")
    return url


def http_fetch(path: str, params: dict[str, Any], key: str) -> Any:
    if path not in ENDPOINTS.values():
        raise QuantgressError(f"unknown endpoint {path}")
    url = f"{base_url()}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"x-api-key": key, "Accept": "application/json", "User-Agent": "trading-desk/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:  # noqa: S310 — loopback-validated URL
            body = r.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        hint = " (check QUANTGRESS_API_KEY — mint one with POST /signup on your Quantgress server)" if e.code in (401, 403) else ""
        raise QuantgressError(f"HTTP {e.code} from {path}{hint}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise QuantgressError(f"Quantgress not reachable at {base_url()} ({e})") from None
    if len(body) > MAX_BYTES:
        raise QuantgressError(f"{path}: response over {MAX_BYTES} bytes")
    try:
        return json.loads(body.decode("utf-8"))
    except ValueError:
        raise QuantgressError(f"{path}: response is not JSON") from None


# ── parsing ──────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Disclosure:
    id: str
    kind: str                 # congress | insider
    actor: str                # politician / insider name
    role: str                 # "Senate" / "House", or the insider's relationship
    party: str                # not in Quantgress's trades view; kept for schema stability ("")
    ticker: str
    transaction: str          # buy | sell | other
    size_low_usd: float | None
    size_high_usd: float | None
    shares: float | None
    traded_date: str          # YYYY-MM-DD ("" if unknown)
    filed_date: str           # YYYY-MM-DD
    raw_transaction: str
    ticker_inferred: bool = False   # Quantgress recovered the ticker from free text
    planned_sale: bool = False      # Form 4 under a 10b5-1 plan (pre-scheduled, weak signal)
    source_url: str = ""

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
        who = f"{self.actor} ({self.role})" if self.role else self.actor
        when = f"traded {self.traded_date or '?'}, filed {self.filed_date}"
        lag = ""
        if self.traded_date and self.filed_date:
            try:
                lag = f" ({(date.fromisoformat(self.filed_date) - date.fromisoformat(self.traded_date)).days}d disclosure lag)"
            except ValueError:
                pass
        kind = "Congressional" if self.kind == "congress" else "Insider (Form 4)"
        notes = []
        if self.ticker_inferred:
            notes.append("ticker inferred from filing text")
        if self.planned_sale:
            notes.append("10b5-1 pre-planned")
        extra = f" [{'; '.join(notes)}]" if notes else ""
        return f"{kind} disclosure: {who} {self.transaction.upper()} {self.ticker}, {self.size_label()}; {when}{lag}.{extra}"


def _first(row: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        v = row.get(k)
        if v not in (None, "", "N/A", "nan", "--"):
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
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", s)
    if m:
        return m.group(1)
    for fmt in ("%m/%d/%Y", "%d-%b-%Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return ""


def _truthy(v: Any) -> bool:
    return v is True or str(v).strip().lower() in ("true", "1", "yes", "t")


def _congress_txn(raw: str) -> str:
    r = raw.strip().lower()
    head = r.split()[0] if r else ""
    if head in ("p", "purchase", "buy") or r.startswith("purchase"):
        return "buy"
    if head in ("s", "sell") or r.startswith(("sale", "s (")):
        return "sell"
    return "other"


def _make_id(*parts: Any) -> str:
    return hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:20]


def normalize_congress(row: Any) -> Disclosure | None:
    """A row of Quantgress's unified `trades` view (both chambers)."""
    if not isinstance(row, dict):
        return None
    ticker = str(_first(row, "tkr", "ticker") or "").strip().upper()
    atype = str(_first(row, "asset_type") or "Stock").strip().lower()
    if not SYMBOL_RE.match(ticker) or atype not in ("stock", "st", "etf", "common stock"):
        return None
    last = str(_first(row, "last_name") or "").strip()
    first = str(_first(row, "first_name") or "").strip()
    actor = f"{first} {last}".strip()
    filed = _date(_first(row, "filed_date", "filed"))
    if not last or not filed:
        return None
    raw_txn = str(_first(row, "tx_type") or "")
    lo, hi = _num(_first(row, "amount_low")), _num(_first(row, "amount_high"))
    traded = _date(_first(row, "txn_date", "tx_date"))
    chamber = {"S": "Senate", "H": "House"}.get(str(_first(row, "chamber") or "").upper(), "")
    return Disclosure(
        id=_make_id("congress", actor, ticker, traded, filed, raw_txn, lo, hi, _first(row, "owner") or ""),
        kind="congress", actor=actor[:120], role=chamber, party="", ticker=ticker,
        transaction=_congress_txn(raw_txn), size_low_usd=lo, size_high_usd=hi, shares=None,
        traded_date=traded, filed_date=filed, raw_transaction=raw_txn[:60],
        ticker_inferred=_truthy(row.get("tkr_recovered")), source_url=str(_first(row, "link") or "")[:300],
    )


def normalize_insider(row: Any) -> Disclosure | None:
    """A row of Quantgress's `insider_trades` table (SEC Form 4)."""
    if not isinstance(row, dict):
        return None
    ticker = str(_first(row, "ticker") or "").strip().upper()
    if not SYMBOL_RE.match(ticker):
        return None
    actor = str(_first(row, "owner_name") or "").strip()
    filed = _date(_first(row, "filed_date", "publication_date"))
    if not actor or not filed:
        return None
    code = str(_first(row, "trans_code") or "").strip().upper()
    ad = str(_first(row, "acquired_disposed") or "").strip().upper()
    shares = _num(_first(row, "shares"))
    price = _num(_first(row, "price_per_share"))
    value = shares * price if shares is not None and price is not None else None
    return Disclosure(
        id=_make_id("insider", _first(row, "accession_number") or "", _first(row, "trans_seq") or "", actor, ticker, code, shares, price),
        kind="insider", actor=actor[:120], role=str(_first(row, "owner_relationship") or "insider").strip()[:60], party="",
        ticker=ticker, transaction={"P": "buy", "S": "sell"}.get(code[:1], "other"),
        size_low_usd=value, size_high_usd=value, shares=shares,
        traded_date=_date(_first(row, "trans_date")), filed_date=filed, raw_transaction=f"{code}/{ad}".strip("/")[:60],
        planned_sale=_truthy(row.get("is_10b5_1")), source_url=str(_first(row, "source_url") or "")[:300],
    )


NORMALIZERS = {"congress": normalize_congress, "insider": normalize_insider}


def parse_batch(kind: str, rows: Any, *, today: date, max_age_days: int) -> list[Disclosure]:
    if not isinstance(rows, list):
        raise QuantgressError(f"{kind}: expected a JSON array")
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


def fetch_recent(kind: str, fetch: Fetcher, key: str, *, today: date, max_age_days: int) -> list[Any]:
    """Page newest-first until rows are older than the cutoff (plus late-filing slack)."""
    stop = today - timedelta(days=max_age_days + LATE_FILING_SLACK_DAYS)
    date_col = "txn_date" if kind == "congress" else "trans_date"
    rows: list[Any] = []
    for page in range(MAX_PAGES):
        batch = fetch(ENDPOINTS[kind], {"limit": PAGE, "offset": page * PAGE}, key)
        if not isinstance(batch, list):
            raise QuantgressError(f"{kind}: expected a JSON array")
        rows.extend(batch)
        dates = [_date(r.get(date_col)) for r in batch if isinstance(r, dict)]
        dates = [x for x in dates if x]
        if len(batch) < PAGE or (dates and min(dates) < stop.isoformat()):
            break
    return rows


def rag_tags(d: Disclosure) -> list[str]:
    tags = [f"class:{EXTERNAL_SIGNAL_HYPOTHESIS}", "source:quantgress", f"kind:{d.kind}", f"ticker:{d.ticker}",
            f"side:{d.transaction}", f"filed:{d.filed_date}"]
    if d.role in ("Senate", "House"):
        tags.append(f"chamber:{d.role.lower()}")
    if d.ticker_inferred:
        tags.append("ticker_inferred:true")
    if d.planned_sale:
        tags.append("planned:10b5_1")
    return tags


# ── ingest ───────────────────────────────────────────────────────────────
def ingest(rag: TradingRag, *, fetch: Fetcher = http_fetch, key: str | None = None, d: Path | None = None,
           kinds: Iterable[str] = ("congress", "insider"), now: float | None = None,
           max_age_days: int | None = None) -> dict[str, Any]:
    """One batch. Returns a report; per-endpoint errors are recorded, not raised (one feed down ≠ both)."""
    key = api_key() if key is None else key
    if not key:
        raise QuantgressError("QUANTGRESS_API_KEY is not set")
    d = d or data_dir()
    qdir = d / "quantgress"
    (qdir / "disclosures").mkdir(parents=True, exist_ok=True)
    now = time.time() if now is None else now
    today = datetime.fromtimestamp(now, timezone.utc).date()
    max_age = max_age_days if max_age_days is not None else int(setting("QUANTGRESS_MAX_AGE_DAYS", str(DEFAULT_MAX_AGE_DAYS)) or DEFAULT_MAX_AGE_DAYS)
    report: dict[str, Any] = {"at": now, "source": "quantgress", "feeds": {}, "new": 0}
    new_rows: list[dict[str, Any]] = []
    for kind in kinds:
        try:
            raw = fetch_recent(kind, fetch, key, today=today, max_age_days=max_age)
            parsed = parse_batch(kind, raw, today=today, max_age_days=max_age)
        except QuantgressError as e:
            report["feeds"][kind] = {"ok": False, "error": str(e)}
            log.warning("quantgress %s: %s", kind, e)
            continue
        added = 0
        for disc in parsed:
            if rag.put(disc.summary(), rag_tags(disc), entry_id=disc.id, now_ms=int(now * 1000)) is not None:
                added += 1
                new_rows.append({**disc.to_dict(), "signal_class": EXTERNAL_SIGNAL_HYPOTHESIS, "ingested_at": now})
        report["feeds"][kind] = {"ok": True, "fetched": len(raw), "parsed": len(parsed), "new": added}
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
        return json.loads(((d or data_dir()) / "quantgress" / "state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


async def poll_forever(rag: TradingRag, *, interval_s: float | None = None) -> None:
    if interval_s is None:
        try:
            interval_s = max(5.0, float(setting("QUANTGRESS_POLL_MINUTES", str(DEFAULT_POLL_MIN)))) * 60
        except ValueError:
            interval_s = DEFAULT_POLL_MIN * 60
    while True:
        try:
            rep = await asyncio.to_thread(ingest, rag)
            log.info("quantgress: %d new disclosures", rep["new"])
        except Exception as e:  # noqa: BLE001 — the poller must never take the bridge down
            log.warning("quantgress ingest failed: %s", e)
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
        except QuantgressError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        return 0
    asyncio.run(poll_forever(rag))
    return 0


if __name__ == "__main__":
    sys.exit(main())
