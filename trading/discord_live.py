"""Live Discord listener for the two trading chats — REST polling with a BOT token.

Why polling, not the gateway websocket: no extra dependency, nothing long-lived to
babysit, and a 60 s cadence is plenty for hypothesis context (never execution).

Setup (all in the repo .env, never sent to the UI):
  DISCORD_BOT_TOKEN=...                      a bot you (or the server admin) added to the
                                             servers, with View Channel + Read Message
                                             History, and the privileged MESSAGE CONTENT
                                             intent enabled in the Developer Portal
  DISCORD_TRADING_CHANNEL_IDS=111...,222...  the two channels
  DISCORD_POLL_SECONDS=60                    optional

Only bot tokens are supported: requests always use "Authorization: Bot <token>",
so a personal (user) token — which Discord's terms forbid automating — fails.
The first poll of a channel does NOT backfill history (use DiscordChatExporter +
the importer for that); it remembers the newest message id and follows from there.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import urllib.error
import urllib.request
from typing import Any, Callable

from discord_ingest import DiscordStore, allowed_channels, parse_api_message
from trading_rag import TradingRag

log = logging.getLogger("trading.discord_live")

API = "https://discord.com/api/v10"
FIRST_POLL_LIMIT = 50


class DiscordAuthError(RuntimeError):
    pass


def _env(key: str, default: str = "") -> str:
    if os.environ.get(key):
        return os.environ[key]
    try:
        from config import REPO_ROOT, _read_dotenv

        return _read_dotenv(REPO_ROOT / ".env").get(key, default)
    except Exception:  # noqa: BLE001
        return default


def bot_token() -> str:
    return _env("DISCORD_BOT_TOKEN").strip()


def configured() -> dict[str, Any]:
    chans = allowed_channels()
    return {"token": bool(bot_token()), "channels": sorted(chans), "pollSeconds": int(_env("DISCORD_POLL_SECONDS", "60") or 60)}


def http_get(path: str, token: str, timeout: float = 15.0) -> Any:
    req = urllib.request.Request(API + path, headers={"Authorization": f"Bot {token}", "User-Agent": "DiscordBot (trading-desk, 1.0)"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — fixed https host
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 429:
            try:
                retry = float(json.loads(e.read().decode("utf-8")).get("retry_after", 5))
            except ValueError:
                retry = 5.0
            raise TimeoutError(f"rate limited, retry after {retry:.1f}s") from None
        if e.code in (401, 403):
            raise DiscordAuthError(f"HTTP {e.code}: bot token invalid or missing channel permission / Message Content intent") from None
        raise


def poll_once(store: DiscordStore, rag: TradingRag, *, universe: list[str], fetch: Callable[[str, str], Any] = http_get,
              now_ms: int | None = None) -> dict[str, Any]:
    token = bot_token()
    chans = allowed_channels()
    out: dict[str, Any] = {"at": now_ms or int(time.time() * 1000), "channels": []}
    if not token or not chans:
        out["skipped"] = "set DISCORD_BOT_TOKEN and DISCORD_TRADING_CHANNEL_IDS in .env"
        return out
    for cid in sorted(chans):
        row: dict[str, Any] = {"channelId": cid}
        try:
            info = fetch(f"/channels/{cid}", token)
            name, guild = info.get("name", ""), info.get("guild_id", "")
            cursor = store.get_cursor(cid)
            q = f"?limit={FIRST_POLL_LIMIT}" if not cursor else f"?limit=100&after={cursor}"
            msgs = fetch(f"/channels/{cid}/messages{q}", token) or []
            parsed = [parse_api_message(m, name, guild) for m in msgs if isinstance(m, dict) and m.get("id")]
            rep = store.ingest(parsed, via="live", rag=rag, universe=universe, channels=chans)
            newest = max((int(m["id"]) for m in msgs if isinstance(m, dict) and str(m.get("id", "")).isdigit()), default=None)
            store.set_cursor(cid, str(newest) if newest else None, out["at"])
            row.update({"channel": name, "fetched": len(msgs), **{k: rep[k] for k in ("kept", "calls", "dup", "rag")}})
        except DiscordAuthError as e:
            row["error"] = str(e)
        except (TimeoutError, urllib.error.URLError, OSError, ValueError) as e:
            row["error"] = f"{type(e).__name__}: {e}"
        out["channels"].append(row)
    return out


async def poll_forever(store: DiscordStore, rag: TradingRag, universe_fn: Callable[[], list[str]], status: dict[str, Any]) -> None:
    """Runs inside the bridge. Quietly idles until a token and channels are configured."""
    while True:
        cfg = configured()
        try:
            if cfg["token"] and cfg["channels"]:
                rep = await asyncio.to_thread(poll_once, store, rag, universe=universe_fn())
                status.clear()
                status.update(rep)
        except Exception as e:  # noqa: BLE001
            log.warning("discord poll: %s", e)
            status.update({"error": str(e)[:200]})
        await asyncio.sleep(max(20, cfg["pollSeconds"]))
