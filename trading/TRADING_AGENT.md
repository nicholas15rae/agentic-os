# Trading desk — operating contract (Engine R + after-hours analyst)

IBKR **paper** only: every path resolves the socket through `config.resolve_endpoint()` (7497 / DU-DF
accounts or LOCKED), Engine R refuses anything that isn't `mode PAPER, port 7497`, the Security Detail
re-checks it per intent and the executor re-checks the lock and endpoint right before placing.

## Who decides what

| Part | Runs | Can do | Can't do |
|------|------|--------|----------|
| **Engine R** (`rule_engine.py`) | CPU, once per weekday at `scan_time_et` (15:45 New York) | evaluate the approved rule on IBKR daily bars, submit bracket intents (`source: rule_engine`) to the desk | read news, Quantgress, Discord or model output; change rules or limits |
| **Analyst** (`analyst.py`) | the local LLM via the gateway's `/api/trading/agent/think`, only weekdays 16:30-08:45 NY and weekends, after Tony's GPU turn | write a review of the day, file up to 3 **pending** one-parameter suggestions | place, size or approve anything; see the 30% test set; touch hard limits |
| **Nic** | — | approve / reject rule changes (typed `APPROVE`), change hard limits (typed `LIMITS`), desk mode, kill switch | — |
| Old Trading Agent (`agent.py`) | **retired as a trader** | its run history stays visible | the bridge no longer starts its loop; `/agent/run` and `/agent/enable` return 410; the desk refuses every `trading_agent` intent in every mode (audit `llm_trade_refused`) |

Desk mode still decides what an Engine R intent becomes: ADVISORY (default) = logged as hypothetical,
SEMI_AUTO = trade card for Nic, FULL_AUTO = sent to the paper bridge (spaced by the pre-trade cooldown).

## Pipeline

```
15:45 ET ─► Engine R gate: paper endpoint · kill-switch lock · autonomous halt · enabled · connected · limits.json valid
         ─► per universe symbol: fresh IBKR daily bars (never cached ones) ─► trend_breakout signal (active version)
         ─► hard limits: daily loss · trades today · open positions · position size (shares + notional caps)
         ─► OrderIntent (LMT at the ask, stop = entry - k·ATR, take-profit = entry + m·ATR, GTC children)
         ─► desk.submit ─► Security Detail ─► pre-trade gates ─► desk mode ─► executor ─► IBKR PAPER
after the close ─► analyst: 70/30 evaluation refresh ─► review pass (today) ─► suggest pass (build set only)
         ─► validated ─► backtested on the active rule's cutoff ─► PENDING in rule_changes ─► Nic
```

## The rule and its parameters

`trend_breakout` (a parameterised Engine A): close > SMA(`sma_fast`) > SMA(`sma_slow`), the close is a new
`breakout_lookback`-session high, volume >= `min_rel_volume` x the average, ATR% <= `max_atr_pct`.
Stop `stop_atr_mult` x ATR, target `target_atr_mult` x ATR, risk `risk_per_trade_pct` of equity,
`disabled_symbols`. Only these knobs exist (`rules.PARAM_SCHEMA`, each with hard bounds). Versions live in
`desk.db` (`rule_versions`); `data/trading/rules/active.json` is a readable copy.

## Hard limits (Nic only): `data/trading/rules/limits.json`

| Field | Default | Effect |
|-------|---------|--------|
| `max_daily_loss_base` | 1500 | day's P&L (realized + unrealized, base currency) at or below minus this: no new entries |
| `on_daily_loss` | `stop_entries` | `kill_switch` instead trips the E-stop (lock, cancel, flatten) once that day |
| `max_position_shares` | 200 | per entry |
| `max_position_notional_base` | 25000 | per entry, base currency |
| `max_trades_per_day` | 3 | Engine R entries per NY day (hypothetical ones count too) |
| `max_open_positions` | 3 | held + working entries |
| `scan_time_et` | 15:45 | the daily scan |
| `universe` | SPY QQQ IWM GLD SLV USO UNG | symbols Engine R may trade (the pre-trade allowlist still applies) |

Unknown P&L fails closed (no entry). An invalid file blocks Engine R. The desk's own caps
(`risk_limits.json`: 2.5% daily drawdown breaker, 20 orders/day, 10% position) and `risk-policy.json`
pre-trade gates apply on top.

## Avoiding overfitting: the 70/30 report

`backtest.py`: trades sorted by entry date; the cutoff is the entry date at the 70% mark of the **active**
rule's trades. Build = oldest ~70%, simulated with bars before the cutoff only (nothing after it can shape
a build number); test = newest ~30%, never shown to the analyst. A proposal is scored on the **same**
cutoff. Each set reports trades, win rate, average win / loss (R and %), expectancy, total R and max
drawdown (R and % of equity). The paper journal (Engine R's closed trades) gets the same split, reported
separately. A verdict flags "better on build but not on test: likely overfit"; it is never applied
automatically. Daily bars are cached in `data/trading/bars_cache/` so the report works with TWS closed.

## Untrusted text

No external text reaches Engine R, the rule parameters or the hard limits. The analyst's prompts hold only
the desk's own numbers and universe tickers, fenced as data; no Quantgress, Discord, news or trade theses.
Its output is untrusted: only the defined JSON fields are read, prose is capped and stored as data
(`untrusted: true`), and a suggestion is a pending row until Nic approves it.
Quantgress disclosures are still ingested into `trading_rag` as External Signal Hypotheses for Nic to read
(`GET /api/trading/signals`); a manual intent citing only them is still rejected (`signal_provenance`).

## Logs (hash-chained `audit.db`; `GET /api/trading/rules/log`)

`rule_scan`, `rule_signal` (every symbol, taken or not, with the reason), `rule_trade` (every submitted
entry with its rule version, reason, sizing and desk verdict), `rule_limit_block`, `rule_change_proposed`
/ `_approved` / `_rejected`, `ruleset_activated`, `rule_limits_changed`, `rule_evaluation`, `analyst_run`,
`llm_trade_refused`, plus the desk's `intent_evaluated`, `order_submitted`, `trade_closed`, `kill_switch`.

## Runbook (desktop PowerShell; loopback scripts are exempt from the PIN step-up, the UI and the phone are not)

```powershell
Invoke-RestMethod http://127.0.0.1:8080/api/trading/rules                              # active version, limits, pending, last scan
Invoke-RestMethod "http://127.0.0.1:8080/api/trading/rules/changes?status=pending"     # each with its build/test numbers
Invoke-RestMethod -Method Post http://127.0.0.1:8080/api/trading/engines/r/changes/<id>/approve -ContentType application/json -Body '{"confirm":"APPROVE","note":"why"}'
Invoke-RestMethod -Method Post http://127.0.0.1:8080/api/trading/engines/r/changes/<id>/reject -ContentType application/json -Body '{"note":"why not"}'
Invoke-RestMethod -Method Post http://127.0.0.1:8080/api/trading/engines/r/propose -ContentType application/json -Body '{"params":{"min_rel_volume":1.5},"reason":"my idea"}'
Invoke-RestMethod -Method Post http://127.0.0.1:8080/api/trading/engines/r/limits -ContentType application/json -Body '{"limits":{"max_trades_per_day":2},"confirm":"LIMITS","reason":"why"}'
Invoke-RestMethod -Method Post http://127.0.0.1:8080/api/trading/engines/r/evaluate -ContentType application/json -Body '{}'   # refresh the 70/30 report (TWS up)
Invoke-RestMethod "http://127.0.0.1:8080/api/trading/rules/log?limit=200"
```

A change approved against an older version whose parameter has since moved is refused as `stale`.

**Kill switch from the phone:** Command Center on the phone (gateway HTTPS) → Trading → red KILL SWITCH
(arm, confirm). It calls `POST /api/trading/kill-switch`, which is never PIN-gated and still locks when the
bridge is down (the gateway writes `TRADING_LOCKED.json` itself). The signed webhook
`POST /api/security/emergency-kill` (phone shortcut / n8n over NetBird) writes the same lock. Either way
Engine R stops at once (lock + halt). Resume: typed `RESET` on the kill-switch reset, then re-arm the mode.
