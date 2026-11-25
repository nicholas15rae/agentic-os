# Orchestrator policy + Live Observer Mode — proposal (awaiting approval)

Status: **proposal only, no code written.** Built in ONE build + restart after approval (the daemon
stagger that is already written ships in the same build).

## Evidence this is based on (2026-11-24 reports, `telemetry/diagnostics/reports/`)

- Single GPU slot, FIFO behind Tony. Heavy Full-Stress: each GPU probe ≈ 18–22 s alone
  (~4k-token prefill + 384 tokens at 22–27 tok/s); serialized wall clock 78.5 s. VRAM peak 78 %,
  spike < 60 MB (KV cache pre-allocated): **no VRAM ceiling, no spill.**
- **Librarian's own exec time matches every other node.** Its "slowest" status is queue position:
  it does its read before joining the queue, so it joins last. (Probe data; the real Librarian
  pipeline is not instrumented yet — §3.)
- **Trading is currently the LOWEST priority, not the highest.** `trading_api.py /agent/think`
  calls `wait_gpu(waitS≤90)` while the desktop holds the GPU, gives up with `gpu_busy`, and when it
  does run it calls LM Studio *without* holding the desktop slot — so a desktop job can start
  alongside it (two generations at once on one card).
- Three daemons share two script permits → one always waits (Observer 5.4 s on Heavy).
- Idle baseline ~35–40 % GPU / high CPU came from TWS's embedded Chromium, browsers, Spotify and
  my own `cargo build` — not the agent stack (§4 separates them).

## 1. `orchestrator_policy.json` (hot-reloadable)

Path: `%APPDATA%\os.agentic.commandcenter\telemetry\orchestrator_policy.json` (created with the
defaults below on first start). The engine checks its mtime every 2 s; a valid change applies on the
next acquisition/tick, no restart. An invalid file is **rejected whole** (last good policy stays) and
the reason goes to `policy_status.json` + the live stream. Never panics.

```jsonc
{
  "version": 1,
  "gpu": {
    "maxConcurrentSlots": 1,                 // default 1 = locked to the single GPU; null = follow Settings (os.json scheduler.maxConcurrency); 2–8 = override (not exposed in the UI)
    "tiers": {                               // lower number = served first; FIFO inside a tier
      "trading": 1, "tony": 1,
      "security": 2, "observer": 2,
      "librarian": 3, "coder": 3, "prompter": 3, "designer": 3, "director": 3, "ops": 3, "bizops": 3
    },
    "defaultTier": 3,
    "queueTimeoutMs": { "1": 0, "2": 120000, "3": 600000 },   // 0 = wait forever; on timeout the job is deferred, not failed
    "preemptTier3ForTier1": false            // true: a waiting Tier-1 cancels a running Tier-3 generation (it re-queues)
  },
  "circuitBreaker": {
    "enabled": true,
    "tier1WaitMs": 1500,                     // a Tier-1 waiter older than this TRIPS the breaker
    "holdMs": 30000,                         // while tripped: new Tier-3 acquisitions are deferred
    "clearAfterIdleMs": 5000                 // …until no Tier-1 waiter for this long
  },
  "tradingHours": {
    "timezone": "America/New_York",          // computed with US DST rules, no tz database
    "window": "08:00-16:00",
    "weekdaysOnly": true,
    "daemonGapSeconds": 90,                  // no two daemon passes start closer than this
    "holdGarbageHygiene": true,              // Garbage's scheduled pass waits for the close (purge handshakes still run)
    "tier3MaxConcurrentBackground": 1,       // optional cap on queued Tier-3 jobs during the window
    "librarianMinIntervalMs": 0              // optional: space Librarian GPU calls during the window
  },
  "librarian": {                             // today these are compile-time consts in librarian.rs
    "packetMaxChars": 9000,                  // PACKET_MAX  (~2.3k tokens of context)
    "itemMaxChars": 1600,                    // ITEM_MAX    (chunk size)
    "perRootHits": 3, "historyHits": 5, "archiveHits": 5,   // top-k per source
    "walkFilesMax": 600, "walkDepth": 4,     // retrieval disk-walk bound
    "archiveGzMaxBytes": 8388608,
    "maxOutputTokens": null                  // null = unchanged
  },
  "liveObserver": { "tickMs": 1000, "port": 8791, "streamMaxMb": 50 }
}
```

The current daemon-stagger constants (`stagger.rs`: 90 s gap, 08:00–16:00 New York, Garbage hold)
become `tradingHours.*` above.

## 2. Live Observer Mode

Toggle in the Diagnostic & Load panel, **OFF by default and OFF after every restart** (no
background cost unless you turn it on). When ON:

- `telemetry/live_observer.json`: the latest tick (atomic rewrite every `tickMs`).
- `telemetry/live_stream.jsonl`: append-only, one line per tick and per event; rotated at
  `streamMaxMb` (`live_stream.1.jsonl`).
- Loopback-only HTTP on `127.0.0.1:<port>` (bound only while ON, closed when OFF), read-only:
  `GET /live` (latest tick JSON), `GET /stream` (Server-Sent Events), `GET /policy` (active policy +
  status), `GET /health`. No write routes.

Tick line:

```jsonc
{
  "t": "tick", "at": 1795547816847, "seq": 412,
  "gpu": {
    "holder": { "label": "worker · coder code · lmstudio", "node": "coder", "tier": 3, "sinceMs": 8120 },
    "queue": [ { "node": "tony", "tier": 1, "waitMs": 640 }, { "node": "librarian", "tier": 3, "waitMs": 5210 } ],
    "depth": 2, "capacity": 1, "settling": 0,
    "breaker": { "tripped": false, "since": null }
  },
  "agents": [ { "node": "coder", "state": "ACTIVE_TOKEN", "waitMs": 900, "inferMs": 8120, "tokPerSec": 24.8 } ],
  "daemons": { "active": ["security"], "lastDecision": { "job": "garbage", "ran": false, "reason": "market hours" } },
  "hw": {
    "system": { "cpuPct": 41, "ramUsedGb": 21.3, "gpuUtilPct": 97, "vramUsedMb": 9640, "vramTotalMb": 12288, "vramHeadroomMb": 2648 },
    "app":    { "cpuPct": 6.2, "ramUsedGb": 1.9, "gpuUtilPct": 88, "processes": ["command-center", "llama-server", "AnythingLLM", "gateway"] },
    "other":  { "cpuPct": 34.8, "gpuUtilPct": 9, "top": [ { "name": "chromium (TWS)", "cpuPct": 18 } ] }
  },
  "policy": { "version": 1, "loadedAt": 1795547800000 }
}
```

Event lines (`"t"`): `probe` (every diag-probe phase), `run` (summary), `policy` (applied /
rejected + why), `breaker` (tripped / cleared + which waiter), `defer` (a job held: who, why),
`ui_stall` (webview main thread blocked > 250 ms, measured in the page), `error`.

Per-run reports, the panel's Copy / Export, the schedule and `request.json` stay exactly as now.

## 3. Librarian profiling

The real Librarian path is: `taskworker` → `librarian::gather_local` (tasks.db + file walk + gz
archives, CPU/disk) → packet ≤ 9000 chars → GPU condense. Instrument each call with
`queueWaitMs`, `retrievalMs` (+ files walked, bytes read, hits per source), `prefillMs` +
`inputTokens` (from LM Studio's streamed `usage` / time to first token), `generationMs` +
`outputTokens` + `tokPerSec`; emitted as `librarian` events in the live stream and kept (last 50)
in every run report. The probe's Librarian gets the same four phases.

Diagnosis rule (applied to the data, reported in the panel):
- retrieval > 30 % of total → **retrieval / disk** (tighten `walkFilesMax`, top-k, archive caps);
- prefill > 40 % and inputTokens high → **oversized context** (cut `packetMaxChars` / `itemMaxChars`);
- queue > 50 % → **scheduling** (tiers / breaker / `librarianMinIntervalMs`);
- generation dominates at normal tok/s and VRAM < 90 % → **genuine compute**, no tuning fixes it.

First-round optimizations (hot, so you can revert by editing the file): Librarian → Tier 3,
breaker on, `packetMaxChars` 9000 → 6000 only if prefill dominates. Nothing is cut blind.

## 4. App vs system telemetry

`sysinfo` per-process CPU/RAM for the app's own tree (command-center + children: gateway Python,
LM Studio `llama-server`, AnythingLLM, Bionic) vs total. GPU per process via the Windows
"GPU Engine" performance counters (PDH; nvidia-smi can't attribute on WDDM); sampled only while Live
mode is on or a run is in flight. Reports gain `hardware.app` / `hardware.other` next to `system`,
and the bottleneck classifier only blames the agent stack for the app share.

## 5. Gateway change needed for Trading = Tier 1 (outside this app)

Tier 1 for Trading can't be done in the desktop alone. Proposed: the desktop exposes an
**always-on** loopback lease API (separate from the Live server; bearer = the existing mesh token):
`POST /arbiter/acquire {node:"trading", maxWaitMs}` → granted when the slot gives it a Tier-1 turn,
`POST /arbiter/release {leaseId}` (auto-expires). `trading_api.py /agent/think` calls it instead of
`wait_gpu`, so Trading jumps the queue AND holds the slot while it generates (no more concurrent
generations). This touches `trading_api.py` / `command_center_api.py` — the Automated Paper Trading
Module session's area — so it needs coordinating with that session.

## Risks

- Tiered admission replaces the semaphore order inside `scheduler.rs` (every GPU caller goes
  through it). Kept behind the policy; `tiers` empty = today's foreground/background behaviour.
- PDH GPU counters cost a little CPU; only sampled while Live/runs are active.
- `maxConcurrentSlots` above 1 can spill VRAM on 12 GB. The default is 1 (locked to the single GPU; the Schematic panel's Orchestration Mode always pins 1). null hands capacity back to the Settings slider; a number overrides it hot.


## v4 — Orchestration Mode (Schematic panel)

Tabs: Schematic Flowchart (default on load) · Gabagool Blueprint · Orbital Ecosystem. The Diagnostic & Load panel opens with an **Orchestration Mode** selector: **Trading Priority** (`gpu.preemptTier3ForTier1: true`) or **Build / Balanced** (`false`); both pin `gpu.maxConcurrentSlots` to 1. It writes the file through the new `policy_set_mode` command (applied at once, logged in `events.jsonl` as `policy` / `action: mode`), refuses to overwrite a file that currently fails validation, and re-reads the live policy every 3 s while the panel is open. New modes: add a row to `MODES` in policy.rs and `ORCHESTRATION_MODES` in diagnostics-model.ts (a test keeps them in sync).
