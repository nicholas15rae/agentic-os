# Phase 5 — The Trading Agent (plan)

Status: **planned 2026-11-24, not started.** Builds on PR #4 (bridge, Security Detail,
kill switch, engines, Discord/Quantgress intel, journal, health check).

## Decisions (from Nic, 2026-11-24)

| Question | Decision |
|---|---|
| Model | **Local `qwen/qwen3.5-9b`** via LM Studio (Tony's model, already loaded: 123k context, Q4_K_M). Free and private; shares the RTX 3060 cooperatively |
| Cadence | **Pre-market brief 09:15 ET + hourly 10:00–15:00 ET** (7 runs/day) + event runs |
| Scope | **ETFs + commodity ETFs**: Engine A's universe (SPY QQQ IWM GLD SLV USO UNG DBC) + approved watchlist adds. No options, no single stocks |
| Rollout | **1 week ADVISORY**, scored, then Nic decides on Semi-auto |

## What the agent is (and isn't)

The agent is the **judgment layer**. Everything around it already exists and stays
in charge:

```
            ┌───────────── deterministic, already built ─────────────┐
 context ─► │  Trading Agent (LLM)  ─► OrderIntent ─► Security Detail │ ─► desk mode ─► executor
  pack      │  thesis + citations       strict schema   16+ checks     │   ADVISORY    (paper only)
            └──────────────────────────────────────────────────────────┘
```

- It **reads** a context pack and **writes** at most 2 OrderIntents per run, each with a
  thesis and citations, plus watchlist and "watch" notes.
- It **never** sizes past the caps (the gate cuts size), never touches the socket, never
  approves its own trades, and talks only to the desk (`submit`) and the Financer (comms
  contract). Kill switch or Financer "halt" → `agentHalted` → it doesn't run.
- If the model is down, busy, or returns junk: **no action** that run (logged), never a
  fallback trade.

## Run cycle

1. **Gate to run.** Skip unless: weekday, the run time is due, the bridge is CONNECTED, not
   locked or halted, and the last health check isn't FAIL.
2. **Build the context pack** (deterministic Python, ~6–10k tokens):
   - Account: equity, buying power, day P&L, open positions/orders, remaining risk budget
     (limits + Financer envelope), today's order count.
   - Market telemetry per universe symbol: last, 1d/5d/20d change, SMA20/50 position, ATR%,
     relative volume, distance to 20-day high/low (from Engine A's metrics), plus Engine A's
     signal state.
   - **Hypotheses** from `trading_rag` per symbol (top-k): Discord calls **with the author's
     and channel's track record attached** (calls, shrunk hit rate, average return), and
     Quantgress disclosures. All are wrapped as untrusted *data*, never instructions.
   - **Lessons**: the last N `trade_journal` post-mortems and the agent's own scored history.
   - Rules recap: OrderIntent schema, ETF-only scope, "an intent citing only hypotheses is
     rejected", max 2 intents per run.
3. **Think.** One model call through the gateway with cooperative GPU waiting (see below).
   Output must be strict JSON:
   ```json
   {"market_view": "...", "decisions": [
      {"symbol": "GLD", "action": "propose|watch|skip", "confidence": 0.0,
       "thesis": "...", "citations": ["telemetry:GLD 20d trend", "discord:dc:…"],
       "intent": {"action": "BUY", "order_type": "LMT", "limit_price": 0, "stop_loss": 0,
                  "take_profit": 0, "quantity": 0, "time_in_force": "DAY"}}],
    "watchlist_add": [{"symbol": "XLE", "reason": "..."}], "notes": "..."}
   ```
4. **Validate.** The JSON is parsed; each `propose` becomes a full OrderIntent (source
   `trading_agent`, deterministic `intent_id` from day + run + symbol) and goes through
   `parse_intent`. Bad ones are logged as agent errors, not retried in a loop.
5. **Submit** to the desk → Security Detail → mode (ADVISORY now: logged as hypothetical).
6. **Record** the run: inputs digest, raw output, decisions, gate verdicts → `agent_runs`
   table + audit row; the market view becomes a `desk_note` in `trading_rag`.

**Event runs** (outside the hourly slots, max 3 per day, at least 20 minutes apart): a new
Discord call on a universe symbol from an author with adjusted hit rate ≥ 60% over ≥ 10
calls, or a new Quantgress insider *buy* on a universe symbol.

## GPU sharing with Tony

- New gateway endpoint `POST /api/trading/agent/think` wraps the gateway's `llm_chat` and
  `extract_json` with a **cooperative wait**: if the desktop holds the GPU (Tony is talking),
  wait up to 90 s for it to finish. If it's still busy, **skip this run** (retried at the
  next slot). It never preempts Tony.
- The prompt cap is 40k characters (the existing `/llm/json` allows 8k). `max_tokens` is about 1,500;
  reasoning inside `<think>` is stripped before the JSON is parsed.
- Expected cost: a 6–10k-token prompt on a 3060 is roughly 30–60 s of GPU per run, so about 7
  minutes a day. It's measured and shown in the UI. It reuses the loaded model, so it needs
  no extra VRAM.

## Prompt-injection and bias hygiene

- Discord and Quantgress text sits inside a fenced data block labelled untrusted, with URLs
  stripped and each item capped. The system prompt says it is data to weigh, never instructions.
- Even a fully hijacked prompt can only emit an OrderIntent, and the gate still enforces
  paper-only, ETF scope (new check: `source=trading_agent` → symbol must be in the universe /
  approved watchlist), sizing, drawdown and hypothesis-only rejection.
- **Track record in context:** every Discord hypothesis carries its author's scored record,
  so "a 41% author is excited" reads differently from "a 68% author over 18 calls".

## Measuring it (the ADVISORY week)

The agent is scored **exactly like a Discord author**. Each hypothetical intent becomes a
"call" (symbol, direction, time) scored at 1/5/20 sessions by `outcomes.py`, and the agent
gets its own row on the leaderboard next to:
- **Engine A** (its hypothetical signals, scored the same way),
- the **Discord authors and channels**,
- a **baseline: "always long SPY"** over the same timestamps (so a rising market doesn't flatter it).

Also tracked: proposals per day, gate approval rate (and which checks reject it most),
schema-error rate, GPU seconds per run, skipped runs (GPU busy / model down).

**Suggested bar to move to Semi-auto** (Nic decides): at least 15 proposals; ≥ 80% schema-valid;
gate approval ≥ 50%; 5-day adjusted hit rate above the SPY baseline; no run that ignored
the scope or cited only hypotheses. Plus the 1-share rehearsal passed.

## Build steps

| Step | What | Files |
|---|---|---|
| 5a | Agent runtime: scheduler, run gate, `agent_runs` store, halt/kill integration, heartbeat | `trading/agent.py`, `desk.py` |
| 5b | Context pack builder (deterministic, token-budgeted) incl. track records + lessons | `trading/agent_context.py` |
| 5c | Model call: `/api/trading/agent/think` (cooperative GPU wait, 40k cap, JSON extract) | `trading_api.py` (reuses `command_center_api.llm_chat` / `extract_json`) |
| 5d | Output validation → OrderIntents; scope check in the gate for `trading_agent` | `trading/agent.py`, `security_detail.py` |
| 5e | Scoring: agent + Engine A hypothetical calls + SPY baseline into the leaderboards | `outcomes.py`, `desk.py` |
| 5f | Event triggers (strong Discord author / Quantgress buy) with daily cap and spacing | `trading/agent.py` |
| 5g | UI: Agent panel: on/off, next run, last market view, decisions + gate verdicts, track record vs baselines, GPU seconds. The typed contract gets locked first (component-contract) | `features/trading/AgentPanel.tsx` |
| 5h | Health check: agent loop heartbeat, last run age, model reachable | `healthcheck.py` |

Tests (stdlib, no GPU): context budget and fencing, JSON validation (bad, partial, `<think>`
wrapped, extra fields), scope rejection, halt/lock skip, GPU-busy skip, deterministic ids
(no duplicate proposals across retries), event-trigger caps, scoring vs baseline. Plus a live
dry run: one real model call on today's context with nothing submitted, output shown.

## Open questions for later

- After the ADVISORY week: Semi-auto (cards to approve), and whether to widen scope to
  options (Engine B) or Discord/Quantgress single stocks.
- Should the pre-market brief also go to you (toast or Telegram) as a one-paragraph market view?
- Re-evaluate the model if the 9B's theses are weak: Gemini Flash (free tier, data to Google)
  or Claude (paid), both drop-in behind `/agent/think`.
