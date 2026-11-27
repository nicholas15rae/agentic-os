# desk-cli: trading desk control, Dead Man's Switch and Master Stop-Loss

`desk-cli` runs the paper trading desk without the Command Center. It works from PowerShell, cmd
and Git Bash. It needs no Tauri, gateway or GUI, only the trading venv. Every command accepts
`--json`. The bridge keeps running as before. desk-cli and its watchdog run beside it.

```powershell
.\desk-cli.ps1 status            # PowerShell
desk-cli.cmd status              # cmd
./desk-cli status                # Git Bash
trading\.venv\Scripts\python.exe trading\desk_cli.py status   # direct
```

## How it fits

```
TWS 7497 ── 11 bridge (ro, GUI telemetry) ── 12 market data (ro) ── 13 executor (desk brackets) ── 19 kill switch
         └─ 20 overseer (ro probe/data) ── 21 overseer act (rw, only while acting)
         └─ 22 desk-cli (ro reads)       ── 23 desk-cli act (rw, only after a confirmation)
         └─ 24 overseer-snapshot (ro)    ── 25 status / watch (ro)
```

- **The CLI and watchdog never share a client id with the GUI or bridge.** Each id is held under an
  exclusive OS lease (`data/trading/clients/<id>.lease`), so two CLI runs, or the CLI and the
  overseer, can't dial the same id. Override the ids with `IBKR_CLIENT_ID_OVERSEER`,
  `…_OVERSEER_ACT`, `…_CLI` and `…_CLI_ACT`. They must be distinct from 11/12/13/19.
- **The endpoint is still `config.resolve_endpoint()`:** paper 7497, loopback only. A non-paper
  account refuses to connect.
- **Working orders always come from a fresh TWS read**, never from the bridge's list. The bridge's
  ib cache never hears that another client's order was cancelled. On 2026-11-24 the GUI E-stop
  (client 19) cancelled the SPY bracket, and the bridge kept listing it as working. Read-only
  clients:
  - `status` and `watch` use 25;
  - `reconcile`, `unlock` and `kill` use 22;
  - `overseer-snapshot` uses 24.

  The bridge snapshot only supplies account, P&L and marks. If TWS can't be read, these commands
  fall back to it, and they say the orders may be stale (`--bridge-only` forces that). Verified
  live: a read-only client sees client 13's executions.
- **Order ownership.** TWS lets only the client id that placed an API order cancel it. The desk's
  brackets belong to the executor (13), which lives inside the bridge. While the bridge is alive,
  desk-cli and the overseer **won't** borrow 13. Cancelling a bridge-owned leg is then reported as
  `BLOCKED (OWNER_IS_BRIDGE)`, and a liquidation that needs it does **not** sell, because a
  resting leg could fill too and flip the position. When the bridge is dead, they borrow 13
  under a lease. `kill --mode all` uses `reqGlobalCancel`, which works from any client.
  While the bridge is alive, its own executor cancels them: desk-cli and the overseer call the
  bridge's `POST /orders/cancel {orderIds, reason}` (audited, cancels only client 13's working
  orders, never places anything, allowed while LOCKED). A bridge started before this route
  existed answers 404, and those legs then stay `BLOCKED (OWNER_IS_BRIDGE)`. **Restart the bridge
  to load the route.**

## Commands

| Command | What it does | Broker writes | Confirmation |
|---|---|---|---|
| `status [--bridge-only]` | lock, desk mode, bridge/TWS, account, positions with bracket status, overseer | none | — |
| `watch [--interval 2s] [--count N]` | `status`, refreshed | none | — |
| `reconcile [--source auto\|bridge\|tws] [--lock-on-drift]` | broker ground truth vs desk.db. Exit **2** on drift | none | — |
| `reconcile --apply-broker-truth` | moves ORPHAN_INTENT intents to `cancelled` (needs TWS executions) | desk.db only | `CONFIRM BROKER TRUTH` |
| `lock [--reason]` | persistent LOCK. New intents are refused; brackets are untouched | none | — |
| `halt [--reason]` | LOCK + mode ADVISORY + agent halted | none | — |
| `unlock` | fresh reconcile must pass, then the lock is removed | none | `CONFIRM UNLOCK` (human only) |
| `kill --cancel-entries` | LOCK, then cancel unfilled entry orders. Protective legs stay | cancels | `CONFIRM CANCEL` |
| `kill --symbol XLE [--symbol …]` | LOCK, cancel that position's legs (acknowledged), sell only that position | cancels + MKT | `CONFIRM LIQUIDATE XLE` |
| `kill` (no symbol) | same, targeting what the overseer last scored tier 2, plus naked positions | cancels + MKT | `CONFIRM LIQUIDATE …` |
| `kill --mode all` | LOCK, global cancel (brackets too), flatten every position at market | everything | `CONFIRM FLATTEN` |
| `audit [--limit 25] [--source ledger\|db] [--verify]` | the append-only ledger, hash chain verified. Exit 2 if tampered | none | — |
| `overseer [--interval S] [--once] [--detach]` | runs the watchdog | when armed | — |
| `overseer --arm` / `--disarm` | let it act / observe only | none | `CONFIRM ARM` / `CONFIRM DISARM` (disarm is human only) |
| `overseer-snapshot` | one compact payload (below) | none | — |

Exit codes:
- **0** ok
- **1** error
- **2** drift or a failed check
- **3** confirmation refused or aborted
- **4** refused by a safety rule (e.g. unlock while drifting)
- **5** action only partly done (see the ledger)

## Two-stage confirmation

1. The CLI prints the **exact impact** to stderr: positions (qty, avg, mark, unrealized P&L),
   every working order it will touch (id, owner client, side, type, price, TIF, ref), the
   unrealized P&L at risk and the account's daily P&L. Then it asks `Proceed? [y/N]`.
2. You type the token exactly, e.g. `CONFIRM FLATTEN`.

Non-interactive use takes one of two forms:
- `--system-trigger "<reason>"`, for automation. It is **refused** for `unlock` and
  `overseer --disarm`: an automated unlock would defeat the lock.
- `--force --confirm-token "<exact token>"`.

Every outcome (CONFIRMED, ABORTED, REFUSED, FORCED, SYSTEM_TRIGGER) is written to the ledger
before anything happens. A refused kill changes nothing, not even the lock.

## The LOCK

- **The lock is the same `data/trading/TRADING_LOCKED.json` the kill switch writes.** The running
  bridge honours it at once, with no restart:
  - the Security Detail's `kill_switch` check rejects every intent;
  - `Executor._guard()` refuses to place anything.
- **Re-locking only widens it:** new breakers are added, and the first incident stays the cause.
- **Locks written by desk-cli and the overseer carry `requiresReconcile`.** `desk-cli unlock`
  runs a fresh reconcile. It refuses if that reconcile drifts, if no reconcile has passed, or if
  the last pass is older than `unlock.reconcile_max_age_s` or older than the lock.
- The GUI's typed-RESET button (`kill_switch.reset_lock`) now refuses a `requiresReconcile` lock
  until a passing reconcile exists. The typed RESET is still required. A plain E-stop lock resets
  as before. This is active after the next bridge restart.
- The GUI E-stop is the Automated Paper Trading Module's 3-press ARM → CONFIRM → EXECUTE flow
  (button or Ctrl+Shift+X). It isn't changed here.

## Pre-trade gates (`trading/pretrade.py`)

These are deterministic code, not prompts. They are added on top of the Security Detail's checks
(port/mode, lock, daily drawdown, idempotency, duplicate, cooldown, daily order cap, hours,
spread/drift, volume, volatility, sizing, concurrency, exposure). Every check is reported, and
each `gate()` call writes one `pretrade_check` ledger line.

| Check | Rule |
|---|---|
| `allowlist` | symbol (an option's underlying) must be in `pretrade.allowlist`, for every source |
| `max_shares` | quantity ≤ `max_shares_per_order` (options: contracts ≤ that / 100) |
| `max_notional` | qty × entry × multiplier × FX ≤ `max_notional_per_order_base`. An unknown entry or FX fails |
| `rate_limit` | fewer than `max_orders_per_minute` passed intents in the last 60 s |
| `global_cooldown` | ≥ `global_cooldown_s` since the last passed intent |
| `intent_hash` | same content (any `intent_id`) refused within `intent_hash_window_s`, so retries collide |
| `bracket` | stop required. Take-profit required when `require_take_profit`. Children are GTC by construction |
| `stale_quote` | two-sided quote **with a tick timestamp** no older than `max_quote_age_s` |
| `stale_snapshot` | bridge snapshot age ≤ `max_snapshot_age_s` |

**Wired into the desk** (active after the next bridge restart): `desk.submit` in FULL_AUTO and
`desk.approve` in SEMI_AUTO run `pretrade.gate()` right before the executor. The gate runs after
the Security Detail and only when an order is really about to be sent, so ADVISORY hypotheticals
don't use up the rate limit.

- A refusal marks the intent `rejected` with the failing checks, and writes `pretrade_rejected`
  to audit.db.
- A missing or invalid `risk-policy.json` refuses the order (fail closed).
- Quotes carry their tick time (`market_data.quote()` now returns `time`, and clears the reused
  ticker first). An untimed or stale quote is refused.

## Broker-is-truth

Agents and engines only propose (desk.db intents). Only TWS evidence moves state:

- **`reconcile`** compares TWS positions, working orders and today's executions with desk.db.

  | Code | Meaning |
  |---|---|
  | `PHANTOM_ORDER` | working order not tied to an intent or a system prefix (manual TWS orders) |
  | `ORPHAN_INTENT` | desk says submitted; TWS has no order, fill or position |
  | `QTY_MISMATCH` | broker position ≠ the desk's expected position |
  | `UNTRACKED_POSITION` | a position with no desk intent |
  | `UNLOGGED_FILL` | an execution not tied to an intent |
  | `NAKED_POSITION` | no GTC stop, an undersized stop, or a DAY stop |
  | `OVER_HEDGED` | stop qty > position |
  | `MISSING_TAKE_PROFIT` | warning only |
  | `EXECUTIONS_UNAVAILABLE` | warning only |

- **An armed overseer locks with `STATE_DRIFT`** when drift persists for 2 consecutive ticks.
- **`submitted → cancelled`** happens only on TWS evidence: automatically for orders the overseer
  itself cancelled (TWS-acknowledged), otherwise through `reconcile --apply-broker-truth`.

## Dead Man's Switch (`desk-cli overseer`)

It is a detached, single-instance process (`overseer.lock`). It writes
`overseer_heartbeat.json` and `overseer_state.json` every tick (`dead_mans_switch.poll_s`).

Heartbeats:
- **Command Center:** a process handle on `command-center.exe`. A clean exit (code 0) is a clean
  close. A non-zero exit is a crash. `IsHungAppWindow` detects a freeze. This needs no app change.
- **Bridge:** `/health` answers and the snapshot is less than 10 s old.
- **TWS API:** `reqCurrentTime` on client 20, every `tws_probe_s`, and immediately when the bridge
  reports that TWS dropped.

| Event | Response |
|---|---|
| clean close (HIBERNATE) | verify every position's broker-side GTC stop + take-profit (ledger `hibernate`); alert `HIBERNATE_UNPROTECTED` if not; halt autonomous entries (agent halted, mode ADVISORY) |
| crash, freeze or lost heartbeat ≥ `grace_s` (30–60) | LOCK (`DMS_CC` / `DMS_BRIDGE` / `DMS_TWS`); cancel unfilled entries; per position: protected and tier < 2 → left alone + `DEGRADED_LOCKED` alert; naked → `naked_action` (`emergency_stop`: GTC STP at max(ATR × mult, min %) from the market, or `liquidate`); tier 2 → selective liquidation |
| TWS unreachable at trigger time | the LOCK is written immediately; broker steps are `pendingActions` and run when the API answers |
| everything back | **stays LOCKED** (`RECOVERING_LOCKED`) until `reconcile` passes and `unlock` is confirmed |

**Observe vs armed:** it starts in **observe** mode. It computes everything and logs `would_act`,
but never locks, cancels or trades. `desk-cli overseer --arm` (dual confirmation) arms it, and
the running loop picks that up on its next tick.

Start it detached:

```powershell
.\desk-cli.ps1 overseer --detach
```

The log goes to `data/trading/overseer.log`. To run it at logon, add that line to the existing
`G:\ai-startup` task (not done automatically).

## Master Stop-Loss (`trading/master_stop.py`)

It runs per stock/ETF position every `master_stop.eval_interval_s`. Inputs come from client 20:
quote with tick time, 1-min bars, 40 daily bars (ATR), and TWS implied vol (generic tick 106).

- **Noise buffer** = max(`noise_buffer_atr_mult` × ATR%, `noise_buffer_min_pct`). A drawdown
  inside it is **always tier 0**, whatever the slope or volume.
- **Factors**, each from 0 to 1:
  - drawdown beyond the buffer (full at `drawdown_full_scale_atr_mult` ATRs);
  - adverse slope in ATR per bar (least squares over `slope_window_bars`);
  - relative volume, counted only while the slope is adverse;
  - volatility expansion: realized vs IV. Without IV it falls back to range vs ATR and sets
    `IV_FALLBACK`.
- **Breakdown Score** = Σ weights × factors. It is logged with reason codes (`DRAWDOWN`,
  `ADVERSE_SLOPE`, `VOLUME_SURGE`, `VOL_EXPANSION`, `IV_FALLBACK`, `NOISE_BUFFER`, `IN_PROFIT`,
  `STALE_DATA`, `DATA_MISSING`, `HARD_STOP`, `TIER2_PENDING_CONFIRMATION`, `BELOW_THRESHOLD`).
- **Tiers:**

  | Tier | When | Action |
  |---|---|---|
  | 0 | score below `tier1_score`, or inside the noise buffer | hold |
  | 1 | score ≥ `tier1_score` | alert, plus a desk lock if `tier1_lock_desk` |
  | 2 | score ≥ `tier2_score` on `tier2_confirm_evals` consecutive evaluations, with fresh data; or a drawdown ≥ `hard_stop_pct` | selective liquidation of that position only (cancel its legs, then MKT), plus LOCK `MASTER_STOP_<SYM>` |

  Healthy positions are not touched. Stale data (older than `max_data_age_s`) never reaches tier 2.
- **Hard circuit breakers always override:**
  - daily loss cap (`risk_limits.max_daily_loss_pct`), with `daily_loss_action`
    `lock_cancel_entries` or `flatten_all`;
  - a rejection/error storm (`rejection_storm_count` in `rejection_storm_window_s`, from audit.db
    `order_failed` plus ledger FAILED);
  - a naked position beyond `naked_grace_s`;
  - `STATE_DRIFT`;
  - an invalid `risk-policy.json` or `risk_limits.json`.

## `data/trading/risk-policy.json`

The file is created with defaults on first use by a write path. Loading is strict: an unknown key,
a wrong type or an out-of-range value fails closed (LOCK `POLICY_INVALID`). A partial file merges
over the defaults. Main knobs:

```jsonc
{
  "pretrade": { "allowlist": ["SPY", "QQQ", "..."], "max_shares_per_order": 200, "max_notional_per_order_base": 25000,
                "max_orders_per_minute": 3, "global_cooldown_s": 20, "intent_hash_window_s": 900,
                "require_take_profit": true, "options_exempt_from_stop": true, "max_quote_age_s": 15, "max_snapshot_age_s": 10 },
  "dead_mans_switch": { "grace_s": 45, "poll_s": 5, "tws_probe_s": 15, "on_clean_close": "halt_autonomous",
                        "cancel_unfilled_entries": true, "naked_action": "emergency_stop",
                        "emergency_stop_atr_mult": 1.5, "emergency_stop_min_pct": 1.0 },
  "master_stop": { "noise_buffer_atr_mult": 0.5, "noise_buffer_min_pct": 0.35, "drawdown_full_scale_atr_mult": 2.0,
                   "slope_window_bars": 15, "slope_full_scale_atr_per_bar": 0.08, "rel_volume_window_bars": 30,
                   "rel_volume_full_scale": 3.0, "vol_expansion_full_scale": 2.0,
                   "weights": { "drawdown": 0.4, "slope": 0.25, "rel_volume": 0.15, "volatility": 0.2 },
                   "tier1_score": 0.45, "tier2_score": 0.7, "tier2_confirm_evals": 3, "tier1_lock_desk": false,
                   "hard_stop_pct": 4.0, "max_data_age_s": 120, "eval_interval_s": 60 },
  "circuit_breakers": { "daily_loss_action": "lock_cancel_entries", "rejection_storm_count": 5,
                        "rejection_storm_window_s": 300, "naked_grace_s": 60 },
  "unlock": { "reconcile_max_age_s": 120 }
}
```

## `overseer-snapshot --json` (for Claude Code)

It is read-only. It runs one dry overseer tick: no lock, no orders, no state file. It returns:

- `lock`: `{locked, reason, incidentId, requiresReconcile, breakers[]}`;
- `deadMansSwitch`: `{overseer: {running, armed, dms, heartbeatAgeS}, liveView, lost, graceS}`;
- `heartbeats`: `{cc, bridge, tws}` → `{ok, state, detail}`;
- `reconcile`: `{ok, counts, drift[], source}`;
- `positions[]`: `{symbol, qty, avgCost, bracket, stop, takeProfit, nakedForS, unrealizedPnl,
  drawdownPct, slopeAtrPerBar, relVolume, atrPct, iv, ivFallback, score, tier, reasonCodes, stale}`;
- `circuitBreakers`: `{active[], inLock[]}`;
- `plannedActions[]`: what an armed overseer would do right now;
- `ledger`: `{chain, last[10]}`.

Suggested agent loop:
1. Run `desk-cli overseer-snapshot --json`.
2. If `reconcile.ok` is false, or any position is unprotected or tier ≥ 1, report it to the user.
3. Never run `kill`, `unlock` or `--arm` without the user's explicit go-ahead. Those commands
   exist for humans or for the overseer's own system triggers.

## Files

All of these live in `data/trading/`:

| File | Purpose |
|---|---|
| `ledger.jsonl` (+ `.lock`) | append-only, hash-chained event log; `audit` verifies it |
| `TRADING_LOCKED.json` | the lock, shared with the kill switch |
| `reconcile_last.json`, `reconcile_state.json` | last reconcile stamp; naked-since timers |
| `overseer_state.json`, `overseer_heartbeat.json`, `overseer_armed.json`, `overseer.log` | watchdog state and log |
| `clients/<id>.lease` | client-id leases |
| `risk-policy.json` | the knobs above |

Code: `trading/desk_cli.py`, `overseer.py`, `reconcile.py`, `pretrade.py`, `master_stop.py`,
`safety_actions.py`, `broker_truth.py`, `desk_lock.py`, `ledger.py`, `risk_policy.py`,
`tws_adapter.py`, `desk_sources.py`, `procwatch.py`.

Tests: `tests/test_trading_{ledger,reconcile,pretrade,master_stop,safety_actions,overseer,cli}.py`,
against the mocked TWS in `tests/fake_tws.py`.

```powershell
& .\trading\.venv\Scripts\python.exe tests\run_all.py "test_trading_*.py"
```

`python tests/run_all.py` (system Python) runs these too, as part of the full gate. A test that
needs a package this interpreter lacks skips with the reason, and the runner lists it at the end.
