# Trading Agent — operating contract

The Trading Agent is isolated. Its only peer is the **Financer**; it has no
broker access and cannot place, size or approve an order.

## What it may output

1. **OrderIntent** JSON (schema: `trading/intents.py`) posted to
   `POST /api/trading/intents`. Every entry needs a hard `stop_loss`. Unknown
   fields are refused. `citations` must name what the idea rests on.
2. **Financer envelopes** (`trading/comms.py`): `capital_request`,
   `pnl_report`, `risk_posture_query` to the Financer. Capital comes only from
   the Financer's `budget_envelope`, which can only tighten the hard caps.

## Pipeline every intent goes through

```
Trading Agent ─► OrderIntent ─► parse_intent (strict schema)
             ─► Security Detail (deterministic, no LLM):
                 port/mode = PAPER 7497 · kill switch · daily drawdown breaker
                 idempotency · duplicate · cooldown · daily order cap · market hours
                 two-sided quote · spread · price drift · stop side
                 20d avg volume + traded value (illiquidity) · realized vol + ATR
                 signal provenance · risk per trade · position notional
                 concurrent positions · gross exposure (Financer allocation caps equity)
             ─► mode: ADVISORY (log only) / SEMI_AUTO (your approval, re-checked) / FULL_AUTO
             ─► executor ─► IBKR Paper Trading Bridge
```

## External signals (Quantgress)

Congressional (Senate/House PTR) and insider (SEC Form 4) disclosures come from a
self-hosted Quantgress server (github.com/DMulajkar/Quantgress; `QUANTGRESS_URL`,
loopback only, default http://127.0.0.1:8000; `QUANTGRESS_API_KEY`). They are ingested into the `trading_rag` vault
tagged `class:external_signal_hypothesis`. Read them with
`GET /api/trading/signals?ticker=XYZ` — the response's `context` block opens
with the directive below.

- A disclosure is a **hypothesis**, filed days or weeks after the trade. It is
  never an order and never a reason to trade by itself.
- Cross-reference it with market telemetry (trend, volume, spread, volatility,
  news) and cite both: `"citations": ["quantgress:<id>", "telemetry:SPY 20d trend"]`.
- An intent whose citations are only `quantgress:` / `hypothesis:` is **rejected**
  (`signal_provenance`).
- Disclosure size or politician volume never relaxes a check. An illiquid,
  wide-spread or highly volatile ticker is rejected regardless.
