"""Discord trading-chat ingestion → the isolated trading_rag vault.

Two ways in, one ETL:
  * Historical: DiscordChatExporter exports (JSON, or CSV named
    "Guild - Category - channel [<channel id>].csv") dropped in
    data/trading/discord/inbox/ → `import_inbox()`.
  * Live: discord_live.py polls the configured channels with a BOT token and
    feeds the same `ingest_messages()`.

ETL (deterministic — no LLM decides what a message "means"):
  clean      drop bots, system messages, empty / emoji-only / link-only / tiny
             messages, attachment-only memes; strip custom emoji and mention ids
  normalize  timestamps → UTC epoch ms
  extract    tickers ($XYZ, or bare words from a known liquid universe), asset
             class, direction / bias, timeframe, price levels and strikes,
             macro catalysts, author, channel
  dedup      message key dc:<channel>:<message>, plus the same author posting
             the same text within 10 minutes (cross-posts)
  store      discord.db: every kept message (FTS5-searchable) + structured
             `signals`; messages that are actual calls (ticker + direction)
             also go into trading_rag tagged class:external_signal_hypothesis,
             source:discord — context for the agent, never an order. Each
             call is later scored against real price action (outcomes.py).

Only the channels in DISCORD_TRADING_CHANNEL_IDS are ingested when that is set.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from trading_rag import TagError, TradingRag

TEXT_MIN = 8
DEDUP_WINDOW_MS = 10 * 60 * 1000

# A liquid universe for bare-word tickers ("SPY looks weak"). $-prefixed tickers are always accepted.
KNOWN_TICKERS = set("""
SPY QQQ IWM DIA VTI VOO GLD SLV USO UNG DBC GDX GDXJ XLE XLF XLK XLV XLY XLP XLI XLU XLB XLRE XBI SMH SOXX ARKK TLT HYG LQD
EEM EFA FXI KWEB UVXY VXX SQQQ TQQQ SPXL SPXS SOXL SOXS TNA TZA LABU UCO SCO BOIL KOLD NUGT DUST
AAPL MSFT NVDA AMZN GOOGL GOOG META TSLA AMD INTC AVGO NFLX CRM ORCL ADBE QCOM MU SMCI PLTR COIN MSTR HOOD SHOP UBER ABNB SNOW
JPM BAC WFC GS MS C V MA PYPL SQ XOM CVX OXY COP SLB BA CAT DE LMT RTX GE F GM RIVN LCID NIO BABA JD PDD DIS WMT COST TGT HD
LOW NKE SBUX MCD KO PEP PG JNJ PFE MRNA LLY UNH ABBV CVS T VZ TMUS SPX SPXW NDX RUT VIX ES NQ YM RTY CL GC SI NG HG ZB ZN BTC ETH
""".split())
# Bare words that are tickers AND ordinary English / chat words: only accepted with a $ prefix.
AMBIGUOUS = set("A ALL ARE BE CAN FOR GO IT NOW ON OR SO AM PM ANY BIG FUN LOVE REAL SEE TWO WELL HAS OUT NEW ONE KEY OPEN LOW HIGH RUN DD CEO ATH C F T V MA MS GE DE LOW CAT DIS KO".split())
INDEX_ALIASES = {"SPX": "SPY", "SPXW": "SPY", "NDX": "QQQ", "RUT": "IWM"}
FUTURES = {"ES", "NQ", "YM", "RTY", "CL", "GC", "SI", "NG", "HG", "ZB", "ZN"}
CRYPTO = {"BTC", "ETH"}
COMMODITY = {"GLD", "SLV", "USO", "UNG", "DBC", "GDX", "GDXJ", "UCO", "SCO", "BOIL", "KOLD", "NUGT", "DUST", "CL", "GC", "SI", "NG", "HG"}
ETFS = {"SPY", "QQQ", "IWM", "DIA", "VTI", "VOO", "XLE", "XLF", "XLK", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XBI", "SMH",
        "SOXX", "ARKK", "TLT", "HYG", "LQD", "EEM", "EFA", "FXI", "KWEB", "UVXY", "VXX", "SQQQ", "TQQQ", "SPXL", "SPXS", "SOXL", "SOXS", "TNA", "TZA", "LABU"}

BULL = re.compile(r"\b(long|longs|calls?|buy(?:ing)?|bought|bull(?:ish)?|breakout|break(?:ing)? out|rip(?:ping)?|moon(?:ing)?|squeeze|bounce|reclaim(?:ed)?|higher|upside|adding|load(?:ing|ed)?|send it)\b|🚀|📈|🟢", re.I)
BEAR = re.compile(r"\b(short(?:s|ing)?|puts?|sell(?:ing)?|sold|bear(?:ish)?|breakdown|break(?:ing)? down|dump(?:ing)?|fade|rejected|rejection|lower|downside|trim(?:med|ming)?|tank(?:ing)?|crash(?:ing)?)\b|📉|🔴|🩸", re.I)
# Option phrases read as a unit: "buying puts" is bearish, "selling puts" bullish, "selling calls" bearish.
BUY_WORDS = r"(?:buy(?:ing)?|bought|long|load(?:ing|ed)?|adding|add|grab(?:bing|bed)?)"
SELL_WORDS = r"(?:sell(?:ing)?|sold|short(?:ing)?|writ(?:e|ing))"
BUY_PUTS = re.compile(BUY_WORDS + r"\s+(?:some\s+|more\s+)?puts?\b", re.I)
SELL_PUTS = re.compile(SELL_WORDS + r"\s+(?:some\s+|more\s+)?puts?\b", re.I)
SELL_CALLS = re.compile(SELL_WORDS + r"\s+(?:some\s+|more\s+)?calls?\b", re.I)
SHORTCODE = re.compile(r":[\w+-]+:")
OPTION_RE = re.compile(r"\$?([A-Z]{1,5})\s+(\d{1,5}(?:\.\d{1,2})?)\s*([cp]|calls?|puts?)\b", re.I)
STRIKE_ONLY = re.compile(r"\b(\d{1,5}(?:\.\d{1,2})?)\s*([cp])\b", re.I)
EXPIRY_RE = re.compile(r"\b(\d{1,2}/\d{1,2}(?:/\d{2,4})?|0\s?dte|\d+\s?dte|weeklies|monthlies|leaps?)\b", re.I)
LEVEL_RE = re.compile(r"\b(pt|target|tp|stop|sl|support|resistance|above|below|over|under|entry|reclaim|lose|loses|break)\s*[:@]?\s*\$?(\d{1,5}(?:\.\d{1,2})?)\b", re.I)
TIMEFRAME = [("0dte", re.compile(r"\b0\s?dte\b|\bsame.day\b", re.I)), ("scalp", re.compile(r"\bscalp", re.I)),
             ("day", re.compile(r"\bday ?trade|\bintraday\b|\btoday\b", re.I)), ("swing", re.compile(r"\bswing\b|\bthis week\b|\bovernight\b", re.I)),
             ("leaps", re.compile(r"\bleaps?\b", re.I)), ("position", re.compile(r"\blong.term\b|\binvest", re.I))]
CATALYSTS = {"CPI": r"\bcpi\b", "PPI": r"\bppi\b", "FOMC": r"\bfomc\b|\bfed\b|\bpowell\b|rate (?:cut|hike)", "NFP": r"\bnfp\b|\bjobs report\b|\bpayrolls\b",
             "PCE": r"\bpce\b", "GDP": r"\bgdp\b", "EARNINGS": r"\bearnings\b|\ber\b", "OPEX": r"\bopex\b", "OPEC": r"\bopec\b",
             "TARIFFS": r"\btariffs?\b", "YIELDS": r"\byields?\b|\b10y\b", "VIX": r"\bvix\b"}
CATALYST_RES = {k: re.compile(v, re.I) for k, v in CATALYSTS.items()}
DOLLAR_TICKER = re.compile(r"\$([A-Za-z]{1,5})\b")
WORD = re.compile(r"\b([A-Z]{1,5})\b")
CUSTOM_EMOJI = re.compile(r"<a?:(\w+):\d+>")
MENTION = re.compile(r"<@[!&]?\d+>")
CHANNEL_REF = re.compile(r"<#\d+>")
URL = re.compile(r"https?://\S+")
EMOJI_ONLY = re.compile(r"^[\W_\s]*$", re.U)

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
  msg_key TEXT PRIMARY KEY, guild_id TEXT, guild TEXT, channel_id TEXT NOT NULL, channel TEXT,
  author_id TEXT NOT NULL, author TEXT, ts_ms INTEGER NOT NULL, content TEXT NOT NULL,
  content_hash TEXT NOT NULL, via TEXT NOT NULL, is_call INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_author_hash ON messages(author_id, content_hash, ts_ms);
CREATE INDEX IF NOT EXISTS messages_channel_ts ON messages(channel_id, ts_ms);
CREATE TABLE IF NOT EXISTS signals (
  msg_key TEXT PRIMARY KEY REFERENCES messages(msg_key), tickers TEXT NOT NULL, primary_ticker TEXT,
  asset_class TEXT, direction TEXT, timeframe TEXT, levels TEXT, strikes TEXT, expiries TEXT, catalysts TEXT
);
CREATE INDEX IF NOT EXISTS signals_ticker ON signals(primary_ticker);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(msg_key UNINDEXED, content, author, channel, tickers);
CREATE TABLE IF NOT EXISTS outcomes (
  msg_key TEXT NOT NULL, ticker TEXT NOT NULL, horizon INTEGER NOT NULL, direction TEXT NOT NULL,
  ref_price REAL, exit_price REAL, ret_pct REAL, hit INTEGER, scored_at INTEGER NOT NULL,
  PRIMARY KEY (msg_key, ticker, horizon)
);
CREATE TABLE IF NOT EXISTS sources (
  channel_id TEXT PRIMARY KEY, guild TEXT, channel TEXT, last_msg_id TEXT, last_poll_ms INTEGER, imported INTEGER DEFAULT 0
);
"""


@dataclass
class RawMessage:
    msg_id: str
    channel_id: str
    author_id: str
    author: str
    ts_ms: int
    content: str
    guild_id: str = ""
    guild: str = ""
    channel: str = ""
    is_bot: bool = False
    msg_type: str = "Default"
    attachments: int = 0


@dataclass
class Extracted:
    tickers: list[str] = field(default_factory=list)
    asset_class: str | None = None
    direction: str | None = None
    timeframe: str | None = None
    levels: list[dict[str, Any]] = field(default_factory=list)
    strikes: list[dict[str, Any]] = field(default_factory=list)
    expiries: list[str] = field(default_factory=list)
    catalysts: list[str] = field(default_factory=list)

    @property
    def is_call(self) -> bool:
        return bool(self.tickers) and self.direction in ("bullish", "bearish")


# ── parsing ──────────────────────────────────────────────────────────────────
def parse_ts(s: str) -> int:
    """ISO-8601 (DiscordChatExporter, Discord API) → UTC epoch ms. 7-digit fractions are truncated."""
    s = s.strip()
    m = re.match(r"^(.*?\.\d{1,6})\d*([+-]\d\d:\d\d|Z)?$", s)
    if m:
        s = m.group(1) + (m.group(2) or "")
    s = s.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        for fmt in ("%d-%b-%y %I:%M %p", "%m/%d/%Y %I:%M %p", "%Y-%m-%d %H:%M:%S"):
            try:
                dt = datetime.strptime(s, fmt)
                break
            except ValueError:
                continue
        else:
            raise ValueError(f"unparseable timestamp {s!r}") from None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def parse_export_json(data: dict[str, Any]) -> list[RawMessage]:
    g, ch = data.get("guild") or {}, data.get("channel") or {}
    out = []
    for m in data.get("messages") or []:
        a = m.get("author") or {}
        try:
            out.append(RawMessage(
                msg_id=str(m["id"]), channel_id=str(ch.get("id", "")), author_id=str(a.get("id", "")),
                author=str(a.get("nickname") or a.get("name") or ""), ts_ms=parse_ts(m["timestamp"]),
                content=str(m.get("content") or ""), guild_id=str(g.get("id", "")), guild=str(g.get("name", "")),
                channel=str(ch.get("name", "")), is_bot=bool(a.get("isBot")), msg_type=str(m.get("type", "Default")),
                attachments=len(m.get("attachments") or []) + len(m.get("stickers") or [])))
        except (KeyError, ValueError):
            continue
    return out


FILENAME_CH = re.compile(r"^(?P<guild>.*?) - (?:(?P<cat>.*?) - )?(?P<chan>.*?) \[(?P<id>\d{15,22})\]")


def parse_export_csv(path: Path) -> list[RawMessage]:
    m = FILENAME_CH.match(path.stem)
    if not m:
        raise ValueError(f"{path.name}: CSV exports need the channel id in the name, e.g. 'Guild - channel [123...].csv'")
    out = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for i, row in enumerate(csv.DictReader(f)):
            try:
                ts = parse_ts(row["Date"])
            except (KeyError, ValueError):
                continue
            content = row.get("Content") or ""
            out.append(RawMessage(
                msg_id=hashlib.sha256(f"{row.get('AuthorID')}|{ts}|{content}".encode()).hexdigest()[:18],  # CSV has no message id
                channel_id=m.group("id"), author_id=str(row.get("AuthorID") or ""), author=str(row.get("Author") or ""),
                ts_ms=ts, content=content, guild=m.group("guild"), channel=m.group("chan").strip(),
                attachments=1 if (row.get("Attachments") or "").strip() else 0))
    return out


def parse_api_message(m: dict[str, Any], channel_name: str = "", guild: str = "") -> RawMessage:
    """A message object from the Discord REST API (live listener / relays)."""
    a = m.get("author") or {}
    return RawMessage(msg_id=str(m["id"]), channel_id=str(m.get("channel_id", "")), author_id=str(a.get("id", "")),
                      author=str(a.get("global_name") or a.get("username") or ""), ts_ms=parse_ts(m["timestamp"]),
                      content=str(m.get("content") or ""), guild_id=str(m.get("guild_id", "")), guild=guild, channel=channel_name,
                      is_bot=bool(a.get("bot")), msg_type="Default" if m.get("type", 0) in (0, 19) else str(m.get("type")),
                      attachments=len(m.get("attachments") or []) + len(m.get("sticker_items") or []))


# ── cleaning & extraction ────────────────────────────────────────────────────
def clean_text(s: str) -> str:
    s = CUSTOM_EMOJI.sub(r":\1:", s)
    s = MENTION.sub("@user", s)
    s = CHANNEL_REF.sub("#channel", s)
    return re.sub(r"\s+", " ", s).strip()


def is_noise(m: RawMessage, text: str) -> str | None:
    if m.is_bot:
        return "bot"
    if m.msg_type not in ("Default", "Reply", "0", "19"):
        return "system"
    if not text:
        return "attachment-only" if m.attachments else "empty"
    bare = URL.sub("", text).strip()
    if not bare:
        return "link-only"
    if EMOJI_ONLY.match(SHORTCODE.sub("", CUSTOM_EMOJI.sub("", bare))):
        return "emoji-only"
    if len(bare) < TEXT_MIN and not DOLLAR_TICKER.search(bare):
        return "too short"
    return None


def extract(text: str, universe: Iterable[str] = ()) -> Extracted:
    known = KNOWN_TICKERS | {u.upper() for u in universe}
    x = Extracted()
    tickers: list[str] = []
    for t in DOLLAR_TICKER.findall(text):
        tickers.append(t.upper())
    for t in WORD.findall(text):
        if t in known and t not in AMBIGUOUS:
            tickers.append(t)
    for sym, strike, kind in OPTION_RE.findall(text):
        sym = sym.upper()
        if sym in known or f"${sym}" in text.upper():
            tickers.append(sym)
            right = "C" if kind.lower().startswith("c") else "P"
            x.strikes.append({"ticker": INDEX_ALIASES.get(sym, sym), "strike": float(strike), "right": right})
    if not x.strikes:
        for strike, kind in STRIKE_ONLY.findall(text):
            x.strikes.append({"ticker": None, "strike": float(strike), "right": kind.upper()})
    x.tickers = list(dict.fromkeys(INDEX_ALIASES.get(t, t) for t in tickers))
    bull, bear = len(BULL.findall(text)), len(BEAR.findall(text))
    # Each phrase matched one bull and one bear word above; replace that pair with a clear vote.
    for rx, to_bull in ((BUY_PUTS, False), (SELL_PUTS, True), (SELL_CALLS, False)):
        n = len(rx.findall(text))
        if n:
            bull, bear = (bull - n + 2 * n, bear - n) if to_bull else (bull - n, bear - n + 2 * n)
            if rx is SELL_PUTS:
                bear -= n  # "short"/"sell" and "puts" are both bear words
    # "calls" / "puts" inside option notation are the strongest direction cue.
    bull += 2 * sum(1 for s in x.strikes if s["right"] == "C")
    bear += 2 * sum(1 for s in x.strikes if s["right"] == "P")
    x.direction = "bullish" if bull > bear else "bearish" if bear > bull else ("mixed" if bull else None)
    for name, rx in TIMEFRAME:
        if rx.search(text):
            x.timeframe = name
            break
    x.expiries = [e.lower().replace(" ", "") for e in EXPIRY_RE.findall(text)]
    x.levels = [{"kind": k.lower(), "price": float(p)} for k, p in LEVEL_RE.findall(text)][:10]
    x.catalysts = [k for k, rx in CATALYST_RES.items() if rx.search(text)]
    first = x.tickers[0] if x.tickers else None
    if x.strikes:
        x.asset_class = "option"
    elif first in FUTURES:
        x.asset_class = "future"
    elif first in CRYPTO:
        x.asset_class = "crypto"
    elif first in COMMODITY:
        x.asset_class = "commodity"
    elif first in ETFS:
        x.asset_class = "etf"
    elif first:
        x.asset_class = "equity"
    return x


def content_hash(author_id: str, text: str) -> str:
    return hashlib.sha256(f"{author_id}|{text.lower()}".encode()).hexdigest()[:24]


def allowed_channels() -> set[str]:
    raw = os.environ.get("DISCORD_TRADING_CHANNEL_IDS", "")
    if not raw:
        try:
            from config import REPO_ROOT, _read_dotenv

            raw = _read_dotenv(REPO_ROOT / ".env").get("DISCORD_TRADING_CHANNEL_IDS", "")
        except Exception:  # noqa: BLE001
            raw = ""
    return {c.strip() for c in raw.split(",") if c.strip()}


# ── storage ──────────────────────────────────────────────────────────────────
class DiscordStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def _conn(self):
        c = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        try:
            c.execute("PRAGMA journal_mode=WAL")
            yield c
        finally:
            c.close()

    def ingest(self, msgs: Iterable[RawMessage], *, via: str, rag: TradingRag | None, universe: Iterable[str] = (),
               channels: set[str] | None = None) -> dict[str, Any]:
        rep = {"seen": 0, "kept": 0, "calls": 0, "dup": 0, "noise": {}, "skipped_channel": 0, "rag": 0}
        universe = list(universe)
        rag_batch: list[tuple[str, list[str], str, int]] = []
        with self._conn() as c:
            c.execute("BEGIN")
            for m in sorted(msgs, key=lambda x: x.ts_ms):
                rep["seen"] += 1
                if channels and m.channel_id not in channels:
                    rep["skipped_channel"] += 1
                    continue
                text = clean_text(m.content)
                why = is_noise(m, text)
                if why:
                    rep["noise"][why] = rep["noise"].get(why, 0) + 1
                    continue
                key = f"dc:{m.channel_id}:{m.msg_id}"
                h = content_hash(m.author_id, text)
                if c.execute("SELECT 1 FROM messages WHERE msg_key=?", (key,)).fetchone() or c.execute(
                        "SELECT 1 FROM messages WHERE author_id=? AND content_hash=? AND ABS(ts_ms-?) < ?",
                        (m.author_id, h, m.ts_ms, DEDUP_WINDOW_MS)).fetchone():
                    rep["dup"] += 1
                    continue
                x = extract(text, universe)
                c.execute("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                          (key, m.guild_id, m.guild, m.channel_id, m.channel, m.author_id, m.author, m.ts_ms, text, h, via, int(x.is_call)))
                c.execute("INSERT INTO messages_fts VALUES (?,?,?,?,?)", (key, text, m.author, m.channel, " ".join(x.tickers)))
                if x.tickers or x.catalysts:
                    c.execute("INSERT INTO signals VALUES (?,?,?,?,?,?,?,?,?,?)",
                              (key, json.dumps(x.tickers), x.tickers[0] if x.tickers else None, x.asset_class, x.direction,
                               x.timeframe, json.dumps(x.levels), json.dumps(x.strikes), json.dumps(x.expiries), json.dumps(x.catalysts)))
                c.execute("INSERT INTO sources(channel_id, guild, channel, imported) VALUES (?,?,?,1) "
                          "ON CONFLICT(channel_id) DO UPDATE SET imported = imported + 1, guild=excluded.guild, channel=COALESCE(NULLIF(excluded.channel,''), channel)",
                          (m.channel_id, m.guild, m.channel))
                rep["kept"] += 1
                if x.is_call:
                    rep["calls"] += 1
                    rag_batch.append((key, rag_tags(m, x), rag_text(m, x, text), m.ts_ms))
            c.execute("COMMIT")
        if rag is not None and rag_batch:
            rep["rag"] = rag.put_many([(text, tags, key, ts) for key, tags, text, ts in rag_batch])
        return rep

    # ── reads ────────────────────────────────────────────────────────
    def search(self, q: str, *, ticker: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
        terms = [t for t in re.findall(r"[A-Za-z0-9$]+", q)][:8]
        with self._conn() as c:
            if terms:
                fts = " ".join(f'"{t.lstrip("$")}"' for t in terms)
                rows = c.execute("SELECT m.msg_key, m.ts_ms, m.channel, m.author, m.content FROM messages_fts f JOIN messages m ON m.msg_key=f.msg_key "
                                 "WHERE messages_fts MATCH ? ORDER BY m.ts_ms DESC LIMIT ?", (fts, limit * 3)).fetchall()
            else:
                rows = c.execute("SELECT msg_key, ts_ms, channel, author, content FROM messages ORDER BY ts_ms DESC LIMIT ?", (limit * 3,)).fetchall()
            out = []
            for key, ts, ch, au, content in rows:
                sig = c.execute("SELECT tickers, direction, asset_class FROM signals WHERE msg_key=?", (key,)).fetchone()
                tick = json.loads(sig[0]) if sig else []
                if ticker and ticker.upper() not in tick:
                    continue
                out.append({"key": key, "ts": ts, "channel": ch, "author": au, "content": content, "tickers": tick,
                            "direction": sig[1] if sig else None, "assetClass": sig[2] if sig else None})
                if len(out) >= limit:
                    break
            return out

    def calls_to_score(self, horizon_max: int, now_ms: int, limit: int = 500) -> list[dict[str, Any]]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT m.msg_key, m.ts_ms, m.author_id, m.author, m.channel_id, m.channel, s.primary_ticker, s.direction FROM messages m "
                "JOIN signals s ON s.msg_key = m.msg_key WHERE m.is_call = 1 AND s.direction IN ('bullish','bearish') "
                "AND s.asset_class IN ('etf','equity','commodity','option') "
                "AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.msg_key = m.msg_key AND o.horizon = ?) "
                "AND m.ts_ms < ? ORDER BY m.ts_ms LIMIT ?", (horizon_max, now_ms - horizon_max * 86_400_000 * 7 // 5, limit)).fetchall()
        return [dict(zip(("key", "ts", "authorId", "author", "channelId", "channel", "ticker", "direction"), r)) for r in rows]

    def save_outcomes(self, rows: list[dict[str, Any]]) -> None:
        with self._conn() as c:
            c.execute("BEGIN")
            for r in rows:
                c.execute("INSERT OR REPLACE INTO outcomes VALUES (?,?,?,?,?,?,?,?,?)",
                          (r["key"], r["ticker"], r["horizon"], r["direction"], r["ref"], r["exit"], r["ret"], r["hit"], r["scoredAt"]))
            c.execute("COMMIT")

    def outcome_rows(self) -> list[dict[str, Any]]:
        with self._conn() as c:
            rows = c.execute("SELECT o.horizon, o.ret_pct, o.hit, m.author_id, m.author, m.channel_id, m.channel FROM outcomes o "
                             "JOIN messages m ON m.msg_key = o.msg_key WHERE o.hit IS NOT NULL").fetchall()
        return [dict(zip(("horizon", "ret", "hit", "authorId", "author", "channelId", "channel"), r)) for r in rows]

    def stats(self) -> dict[str, Any]:
        with self._conn() as c:
            n = c.execute("SELECT COUNT(*), SUM(is_call), MIN(ts_ms), MAX(ts_ms) FROM messages").fetchone()
            srcs = c.execute("SELECT channel_id, guild, channel, imported, last_poll_ms FROM sources ORDER BY imported DESC").fetchall()
            scored = c.execute("SELECT COUNT(DISTINCT msg_key) FROM outcomes WHERE hit IS NOT NULL").fetchone()[0]
        return {"messages": n[0] or 0, "calls": n[1] or 0, "from": n[2], "to": n[3], "scoredCalls": scored,
                "sources": [dict(zip(("channelId", "guild", "channel", "messages", "lastPoll"), s)) for s in srcs]}

    def get_cursor(self, channel_id: str) -> str | None:
        with self._conn() as c:
            r = c.execute("SELECT last_msg_id FROM sources WHERE channel_id=?", (channel_id,)).fetchone()
        return r[0] if r else None

    def set_cursor(self, channel_id: str, msg_id: str | None, now_ms: int) -> None:
        with self._conn() as c:
            c.execute("INSERT INTO sources(channel_id, last_msg_id, last_poll_ms) VALUES (?,?,?) ON CONFLICT(channel_id) DO UPDATE SET "
                      "last_msg_id = COALESCE(excluded.last_msg_id, last_msg_id), last_poll_ms = excluded.last_poll_ms", (channel_id, msg_id, now_ms))


def rag_tags(m: RawMessage, x: Extracted) -> list[str]:
    tags = ["class:external_signal_hypothesis", "source:discord", f"channel:{m.channel_id}", f"author:{m.author_id or 'unknown'}"]
    tags += [f"ticker:{t}" for t in x.tickers[:3]]
    if x.direction:
        tags.append(f"bias:{x.direction}")
    if x.asset_class:
        tags.append(f"asset:{x.asset_class}")
    if x.timeframe:
        tags.append(f"timeframe:{x.timeframe}")
    tags += [f"catalyst:{c.lower()}" for c in x.catalysts[:3]]
    return tags


def rag_text(m: RawMessage, x: Extracted, text: str) -> str:
    when = datetime.fromtimestamp(m.ts_ms / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    meta = f"{x.direction or 'no'} bias on {', '.join(x.tickers[:3])}" + (f" ({x.timeframe})" if x.timeframe else "")
    return f"Discord #{m.channel or m.channel_id} · {m.author or m.author_id} · {when}: {meta}. Message: {text}"


# ── historical import ────────────────────────────────────────────────────────
def load_export(path: Path) -> list[RawMessage]:
    if path.suffix.lower() == ".json":
        return parse_export_json(json.loads(path.read_text(encoding="utf-8-sig")))
    if path.suffix.lower() == ".csv":
        return parse_export_csv(path)
    raise ValueError(f"{path.name}: export as JSON or CSV from DiscordChatExporter")


def import_inbox(store: DiscordStore, rag: TradingRag, inbox: Path, *, universe: Iterable[str] = ()) -> dict[str, Any]:
    """Ingest every export in the inbox; processed files move to inbox/done/ (failed ones to inbox/failed/)."""
    inbox.mkdir(parents=True, exist_ok=True)
    channels = allowed_channels() or None
    out: dict[str, Any] = {"files": [], "channelsFilter": sorted(channels) if channels else None}
    for p in sorted(inbox.iterdir()):
        if not p.is_file() or p.suffix.lower() not in (".json", ".csv"):
            continue
        try:
            rep = store.ingest(load_export(p), via="import", rag=rag, universe=universe, channels=channels)
            dest = inbox / "done"
            out["files"].append({"file": p.name, **rep})
        except (ValueError, OSError, TagError, json.JSONDecodeError) as e:
            dest = inbox / "failed"
            out["files"].append({"file": p.name, "error": str(e)[:300]})
        dest.mkdir(exist_ok=True)
        p.replace(dest / f"{time.strftime('%Y%m%d-%H%M%S')}-{p.name}")
    return out
