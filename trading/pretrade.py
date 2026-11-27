"""Pre-trade gates: the last checks an OrderIntent must pass before the executor may act.

`evaluate()` is pure (time comes in as `ctx["now"]`, no I/O) and always reports EVERY
check, pass or fail, so the ledger line shows the full picture. Anything unknown fails
closed: an unknown entry price or FX rate, a quote without a timestamp, a missing
snapshot age, a malformed policy knob (the check errors -> it fails, never passes).

`gate()` is the only function with a side effect: it appends exactly one
`pretrade_check` line to the hash-chained ledger (verdict PASS / REJECT) and, when the
caller did not supply `ctx["recent"]`, reads the recent PASS lines from that ledger to
feed the rate limit, the global cooldown and the duplicate-intent (hash) window. The read
window covers all three (max of 60 s, intent_hash_window_s and global_cooldown_s).
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Callable

OPTION_SEC_TYPES = ("OPT", "BAG")
OPTION_MULTIPLIER = 100  # intents.OPTION_MULTIPLIER
CHECK_KIND = "pretrade_check"
RATE_WINDOW_S = 60.0

CHECK_NAMES = (
    "allowlist",
    "max_shares",
    "max_notional",
    "rate_limit",
    "global_cooldown",
    "intent_hash",
    "bracket",
    "stale_quote",
    "stale_snapshot",
)


# ── helpers ──────────────────────────────────────────────────────────────────
def _num(v: Any) -> float | None:
    """A finite real number, else None (bools are not numbers here)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def _pos(v: Any) -> float | None:
    f = _num(v)
    return f if f is not None and f > 0 else None


def _r2(v: Any) -> Any:
    if v is None:
        return None
    f = _num(v)
    return round(f, 2) if f is not None else v


def _is_option(intent: dict) -> bool:
    return str(intent.get("sec_type") or "STK").upper() in OPTION_SEC_TYPES


def _now(ctx: dict) -> float:
    """ctx["now"] as a finite number. NaN / inf / str / bool / missing raise -> the check fails closed
    (a NaN `now` would otherwise make every `ts > now - window` comparison False = empty history)."""
    if "now" not in ctx:
        raise KeyError("now")
    n = _num(ctx["now"])
    if n is None:
        raise ValueError(f"now {ctx['now']!r} is not a finite number")
    return n


def _price_or_fail(v: Any, name: str) -> float | None:
    """None -> None (absent). A present value must be a positive finite number, else ValueError."""
    if v is None:
        return None
    f = _pos(v)
    if f is None:
        raise ValueError(f"{name} {v!r} is not a positive number")
    return f


def _canon(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


# ── content hash ─────────────────────────────────────────────────────────────
def intent_hash(intent: dict) -> str:
    """sha256 of the economic content. intent_id, thesis, citations and created_at are excluded,
    so a retry of the same order under a new intent_id collides."""
    qty = intent.get("quantity")
    if isinstance(qty, float) and qty.is_integer():
        qty = int(qty)  # 1 and 1.0 are the same order
    legs = []
    for leg in intent.get("legs") or ():
        leg = dict(leg)
        if "strike" in leg:
            leg["strike"] = _r2(leg["strike"])
        legs.append(leg)
    legs.sort(key=_canon)  # leg order is not economic content: a retry with swapped legs must collide
    body = {
        "source": intent.get("source"),
        "symbol": str(intent.get("symbol") or "").strip().upper(),
        "sec_type": str(intent.get("sec_type") or "STK").upper(),
        "action": intent.get("action"),
        "quantity": qty,
        "order_type": intent.get("order_type"),
        "limit_price": _r2(intent.get("limit_price")),
        "stop_loss": _r2(intent.get("stop_loss")),
        "take_profit": _r2(intent.get("take_profit")),
        "legs": legs,
    }
    return hashlib.sha256(_canon(body).encode("utf-8")).hexdigest()


# ── individual checks: each returns (ok, detail) ─────────────────────────────
def _check_allowlist(intent: dict, ctx: dict, pt: dict, h: str) -> tuple[bool, str]:
    sym = str(intent.get("symbol") or "").strip().upper()
    raw_allow = pt["allowlist"]
    if not isinstance(raw_allow, (list, tuple)):
        # a bare string "SPY" would otherwise iterate as "S", "P", "Y"
        return False, f"allowlist is malformed ({type(raw_allow).__name__}, expected a list): fail closed"
    allow = [str(s).strip().upper() for s in raw_allow]
    what = f"underlying {sym}" if _is_option(intent) else sym
    if not sym:
        return False, "intent has no symbol"
    if sym in allow:
        return True, f"{what} is on the allowlist"
    if not allow:
        return False, f"{what} refused: the allowlist is empty (nothing may trade)"
    return False, f"{what} is not on the allowlist"


def _check_max_shares(intent: dict, ctx: dict, pt: dict, h: str) -> tuple[bool, str]:
    qty = _pos(intent.get("quantity"))
    raw_max = _num(pt["max_shares_per_order"])
    if raw_max is None or raw_max < 1:
        # <= 0 would still let max(1, ...) through one option contract
        return False, f"max_shares_per_order {pt['max_shares_per_order']!r} is malformed: fail closed"
    max_shares = int(raw_max)
    if _is_option(intent):
        cap = max(1, max_shares // 100)
        unit = "contracts"
    else:
        cap = max_shares
        unit = "shares"
    if qty is None:
        return False, f"quantity {intent.get('quantity')!r} is not a positive number"
    if qty <= cap:
        return True, f"{qty:g} {unit} <= {cap} {unit}"
    return False, f"{qty:g} {unit} exceeds the {cap} {unit} per-order cap"


def _entry_price(intent: dict, ctx: dict) -> tuple[float | None, str]:
    # A PRESENT but malformed entry_price / limit_price (0, negative, NaN, str) raises -> fail closed;
    # it never silently falls through to a cheaper source.
    e = _price_or_fail(ctx.get("entry_price"), "ctx entry_price")
    if e is not None:
        return e, "ctx entry_price"
    e = _price_or_fail(intent.get("limit_price"), "limit_price")
    if e is not None:
        return e, "limit_price"
    q = ctx.get("quote") or {}
    if isinstance(q, dict):
        side = "ask" if intent.get("action") == "BUY" else "bid"
        e = _pos(q.get(side))
        if e is not None:
            return e, f"quote {side}"
    return None, "unknown"


def _check_max_notional(intent: dict, ctx: dict, pt: dict, h: str) -> tuple[bool, str]:
    cap = float(pt["max_notional_per_order_base"])
    qty = _pos(intent.get("quantity"))
    if qty is None:
        return False, "quantity unknown: notional cannot be computed (fail closed)"
    entry, src = _entry_price(intent, ctx)
    if entry is None:
        return False, "entry price unknown (no entry_price, limit_price or quote side): fail closed"
    fx = _pos(ctx.get("fx_to_base"))
    if fx is None:
        return False, f"FX rate to base currency unknown ({intent.get('currency') or '?'}): fail closed"
    raw_mult = intent.get("multiplier")
    if raw_mult is None:
        mult = float(OPTION_MULTIPLIER) if _is_option(intent) else 1.0  # never under-count an option 100x
    else:
        mult = _pos(raw_mult)
        if mult is None:
            return False, f"multiplier {raw_mult!r} is not a positive number: fail closed"
    if _is_option(intent) and mult < OPTION_MULTIPLIER:
        return False, f"option multiplier {mult:g} < {OPTION_MULTIPLIER}: notional would be under-counted (fail closed)"
    notional = qty * entry * mult * fx
    expr = f"{qty:g} x {entry:g} ({src}) x {mult:g} x fx {fx:g} = {notional:,.2f}"
    if notional <= cap:
        return True, f"{expr} <= {cap:,.2f} base"
    return False, f"{expr} exceeds the {cap:,.2f} base per-order cap"


def _recent(ctx: dict) -> list[dict]:
    """The order history, validated. Anything malformed raises -> the history checks fail closed:
    a non-list (a dict / str would iterate as nothing), a non-dict row, or a row without a finite ts
    (dropping it would under-count the rate limit / miss a duplicate)."""
    rows = ctx.get("recent")
    if rows is None:
        raise ValueError("recent order history unavailable")
    if not isinstance(rows, (list, tuple)):
        raise ValueError(f"recent order history is malformed ({type(rows).__name__}, expected a list)")
    for i, r in enumerate(rows):
        if not isinstance(r, dict) or _num(r.get("ts")) is None:
            raise ValueError(f"recent order history row {i} is malformed ({r!r:.80})")
    return list(rows)


def _ts(r: dict) -> float:
    return float(r["ts"])  # validated by _recent


def _check_rate_limit(intent: dict, ctx: dict, pt: dict, h: str) -> tuple[bool, str]:
    now = _now(ctx)
    cap = int(pt["max_orders_per_minute"])
    n = sum(1 for r in _recent(ctx) if _ts(r) > now - RATE_WINDOW_S)
    if n < cap:
        return True, f"{n} order(s) in the last 60 s (< {cap})"
    return False, f"{n} order(s) in the last 60 s: the limit is {cap} per minute"


def _check_global_cooldown(intent: dict, ctx: dict, pt: dict, h: str) -> tuple[bool, str]:
    now = _now(ctx)
    cool = float(pt["global_cooldown_s"])
    stamps = [_ts(r) for r in _recent(ctx)]
    if not stamps:
        return True, "no recent orders"
    gap = now - max(stamps)
    if gap >= cool:
        return True, f"{gap:.1f} s since the last order (>= {cool:g} s)"
    return False, f"only {gap:.1f} s since the last order: global cooldown is {cool:g} s"


def _check_intent_hash(intent: dict, ctx: dict, pt: dict, h: str) -> tuple[bool, str]:
    now = _now(ctx)
    win = float(pt["intent_hash_window_s"])
    if not isinstance(h, str) or len(h) != 64:
        return False, "intent hash could not be computed: fail closed"
    if not math.isfinite(win) or win < 0:
        return False, f"intent_hash_window_s {pt['intent_hash_window_s']!r} is malformed: fail closed"
    dup = [r for r in _recent(ctx) if r.get("hash") == h and _ts(r) > now - win]
    if not dup:
        return True, f"no identical order in the last {win:g} s"
    last = max(_ts(r) for r in dup)
    return False, f"identical order (hash {h[:12]}) passed {now - last:.1f} s ago, inside the {win:g} s window"


def _check_bracket(intent: dict, ctx: dict, pt: dict, h: str) -> tuple[bool, str]:
    stop = _pos(intent.get("stop_loss"))
    tp = _pos(intent.get("take_profit"))
    need_tp = bool(pt["require_take_profit"])
    option = _is_option(intent)
    exempt = option and bool(pt["options_exempt_from_stop"])
    parts: list[str] = []
    ok = True
    # The exemption only removes the RESTING STP order: the options guard still needs a premium
    # stop to enforce, so stop_loss > 0 is required for every intent (a missing one = naked option).
    if stop is None:
        ok = False
        parts.append(f"stop_loss missing or not > 0 ({intent.get('stop_loss')!r})"
                     + ("; the options guard needs a premium stop to enforce" if exempt else ""))
    elif exempt:
        parts.append(f"options: premium stop {stop:g} is enforced by the desk's options guard (no resting STP)")
    else:
        parts.append(f"stop_loss {stop:g}")
    if tp is not None:
        parts.append(f"take_profit {tp:g}")
    elif need_tp:
        ok = False
        parts.append(f"take_profit required but missing or not > 0 ({intent.get('take_profit')!r})")
    else:
        parts.append("no take_profit (not required)")
    parts.append("children are GTC by construction (executor.build_bracket)")
    return ok, "; ".join(parts)


def _check_stale_quote(intent: dict, ctx: dict, pt: dict, h: str) -> tuple[bool, str]:
    now = _now(ctx)
    max_age = float(pt["max_quote_age_s"])
    q = ctx.get("quote")
    if not isinstance(q, dict):
        return False, "no quote"
    bid, ask = _pos(q.get("bid")), _pos(q.get("ask"))
    if bid is None or ask is None:
        return False, f"quote needs bid and ask > 0 (bid {q.get('bid')!r}, ask {q.get('ask')!r})"
    if q.get("time") is None:
        return False, "quote has no timestamp"
    t = _num(q.get("time"))
    if t is None:
        return False, f"quote timestamp {q.get('time')!r} is not a number"
    age = now - t
    if age < -max_age:
        return False, f"quote timestamp is {-age:.1f} s in the future (clock or feed fault)"
    if age <= max_age:
        return True, f"quote {max(age, 0.0):.1f} s old (<= {max_age:g} s), bid {bid:g} ask {ask:g}"
    return False, f"quote is {age:.1f} s old (> {max_age:g} s)"


def _check_stale_snapshot(intent: dict, ctx: dict, pt: dict, h: str) -> tuple[bool, str]:
    max_age = float(pt["max_snapshot_age_s"])
    raw = ctx.get("snapshot_age_s")
    if raw is None:
        return False, "account snapshot age unknown"
    age = _num(raw)
    if age is None:
        return False, f"snapshot age {raw!r} is not a number"
    if age < -max_age:
        return False, f"snapshot age {age:.1f} s is negative (snapshot from the future: clock fault)"
    if age <= max_age:
        return True, f"snapshot {age:.1f} s old (<= {max_age:g} s)"
    return False, f"snapshot is {age:.1f} s old (> {max_age:g} s)"


_CHECKS: tuple[tuple[str, Callable[[dict, dict, dict, str], tuple[bool, str]]], ...] = (
    ("allowlist", _check_allowlist),
    ("max_shares", _check_max_shares),
    ("max_notional", _check_max_notional),
    ("rate_limit", _check_rate_limit),
    ("global_cooldown", _check_global_cooldown),
    ("intent_hash", _check_intent_hash),
    ("bracket", _check_bracket),
    ("stale_quote", _check_stale_quote),
    ("stale_snapshot", _check_stale_snapshot),
)


def _safe_hash(intent: Any) -> str:
    """intent_hash, or "" when the intent is too malformed to hash (the intent_hash check then fails)."""
    try:
        return intent_hash(intent)
    except Exception:  # noqa: BLE001
        return ""


def _history_window_s(pt: dict) -> float:
    """How far back gate() must read: it has to cover the rate window, the duplicate window AND the
    global cooldown, or a cooldown longer than both would see an empty history and pass."""
    win = RATE_WINDOW_S
    for key in ("intent_hash_window_s", "global_cooldown_s"):
        v = _num(pt.get(key))
        if v is not None and v > win:
            win = v
    return win


def evaluate(intent: dict, ctx: dict, policy: dict) -> list[dict]:
    """[{"name", "ok", "detail"}] for every check, in a fixed order. A check that errors fails."""
    pt = policy.get("pretrade") if isinstance(policy, dict) else None
    pt = pt if isinstance(pt, dict) else {}       # missing keys -> each check errors -> fails
    ctx = ctx if isinstance(ctx, dict) else {}
    intent = intent if isinstance(intent, dict) else {}
    h = _safe_hash(intent)
    out = []
    for name, fn in _CHECKS:
        try:
            ok, detail = fn(intent, ctx, pt, h)
        except Exception as e:  # noqa: BLE001 — fail closed on anything unexpected
            ok, detail = False, f"check error: {type(e).__name__}: {e}"
        out.append({"name": name, "ok": bool(ok), "detail": detail})
    return out


# ── ledger integration ───────────────────────────────────────────────────────
def recent_from_ledger(ledger: Any, now: float, window_s: float) -> list[dict]:
    """PASS `pretrade_check` lines since now - window_s -> [{"ts", "hash", "symbol"}]."""
    rows = ledger.since(now - window_s, (CHECK_KIND,))
    out = []
    for r in rows:
        if r.get("kind") != CHECK_KIND or r.get("verdict") != "PASS":
            continue
        p = r.get("payload") or {}
        out.append({"ts": r.get("ts"), "hash": p.get("hash"), "symbol": p.get("symbol")})
    return out


def gate(intent: dict, ctx: dict, policy: dict, ledger: Any, actor: str) -> dict:
    """evaluate + exactly one ledger line. Returns {"ok", "hash", "checks", "failed"}."""
    ctx = dict(ctx) if isinstance(ctx, dict) else {}
    intent = intent if isinstance(intent, dict) else {}
    if ctx.get("recent") is None:
        pt = policy.get("pretrade") if isinstance(policy, dict) else None
        pt = pt if isinstance(pt, dict) else {}
        try:
            ctx["recent"] = recent_from_ledger(ledger, _now(ctx), _history_window_s(pt))
        except Exception:  # noqa: BLE001 — leave recent None: the history checks then fail closed
            ctx["recent"] = None
    checks = evaluate(intent, ctx, policy)
    failed = [c["name"] for c in checks if not c["ok"]]
    h = _safe_hash(intent)
    ok = not failed and len(checks) == len(CHECK_NAMES)
    symbol = str(intent.get("symbol") or "").strip().upper()
    ledger.append(CHECK_KIND, {"hash": h, "symbol": symbol, "checks": checks, "failed": failed},
                  ref=str(intent.get("intent_id") or ""), verdict="PASS" if ok else "REJECT", actor=actor)
    return {"ok": ok, "hash": h, "checks": checks, "failed": failed}
