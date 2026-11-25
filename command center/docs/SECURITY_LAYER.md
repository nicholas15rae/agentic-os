# Sovereign security layer: setup and verification

Enforcement lives in Rust (`src-tauri/src/security/`) and the gateway edge (`security_api.py`).
The webview only renders state.

- **IPC gate**: every Tauri command passes `security::gate::decide` first (in `lib.rs`).
  - A locked or hard-locked app refuses everything except `security_*`.
  - A mutating command in a protected module needs a live step-up.
- **Gateway**: `StepUpMiddleware` returns 423 for trading, finance and settings writes unless the request carries a Rust-minted `X-CC-Elevation` HMAC token.
  - The token is bound to its module, an expiry and the revocation epoch.
  - The trading E-stop (`/api/trading/kill-switch`) is never gated.
- **Shared files** live in `<repo>/data/security/` (gitignored):
  - `security.config.json` (tunables, hot-reloaded and clamped)
  - `state.json` (epoch, hard lock)
  - `elevation.key`, `remote_kill.key`
  - `security_audit.jsonl` (append-only and hash-chained; `prev` = sha256 of the previous line)

## 1. What to populate

| What | Where | How |
|---|---|---|
| App PIN (Argon2id, 64 MiB / t=3) | OS keychain `security-pin@security` | `gabagool-cli set-pin` |
| Config, elevation key, device id, remote-kill secret | `data/security/` | `gabagool-cli init` (prints the secret **once**) |
| Remote-kill HMAC secret (override) | env or `.env` | `CC_REMOTE_KILL_SECRET` (optional; overrides `remote_kill.key`) |
| Companion pairing key | desktop keychain `companion-pair@security`; phone: Settings → Security → Pair | `gabagool-cli pair-companion` |
| Alert channels | `alerts.channels` in the config (default `["companion", "webhook"]`) | tried in order until one takes the alert; `fanOut: true` sends to all. Unconfigured channels are skipped silently |
| Phone alerts + approvals | nothing extra | `gabagool-cli pair-companion` (writes `companion.paired` for the gateway) |
| n8n fallback (optional) | env or `.env` | `CC_ALERT_WEBHOOK_URL`, optional `CC_ALERT_WEBHOOK_SECRET` (signed `X-CC-Signature`) |
| Twilio / SMTP (opt-in only) | add `"twilio"` / `"email"` to `alerts.channels` | `CC_TWILIO_*` + `CC_ALERT_SMS_TO`; `CC_SMTP_*` + `CC_ALERT_EMAIL_*` |

Phone channel: desktop Rust signs each alert with the pairing key (`alert|id|ts|severity|title|body`) and queues it at `POST /api/security/companion/alert` (loopback). The phone polls `GET /api/security/companion/alerts?since=` every 10 s, checks the signature in Rust and raises an Android notification. Alerts the gateway raises itself are unsigned and shown as "via gateway". The inbox is `data/security/companion_inbox.json` (200 items, 7 days). Step-ups can be approved on the paired phone instead of the PIN (`elevation.allowCompanion`). On Android/iOS the keychain isn't used (keyring has no backend there); keys and the PIN hash live in the app-private data folder, and the first PIN is set in the app.

Notes:

- The gateway (Python) reads alert credentials from the environment and `.env` only. It has no keychain, so put any alert credential the webhook path needs in `.env`.
- Build the CLI with `cargo build --release --bin gabagool-cli` in `src-tauri`. Run it from the repo root, or pass `--dir <repo>\data\security`.

## 2. Crates and plugins added

- `Cargo.toml` additions:
  - `argon2 0.5`
  - `hmac 0.12`
  - `lettre 0.11` (SMTP over rustls, no OpenSSL)
  - `rpassword 7`
  - `windows-future 0.3`
  - `windows` features: `Foundation`, `Security_Credentials_UI`, `Win32_System_WinRT` (Windows Hello)
  - `tokio` feature `rt`
  - `tauri-plugin-biometric 2`, on Android/iOS only
- `default-run = "command-center"`, because a second binary now exists (`src/bin/gabagool-cli.rs`).
- In dev builds, `argon2` and `blake2` compile at `opt-level 3`, so the PIN check stays fast.
- `tauri.conf.json` and the capabilities are unchanged. Biometrics are called from Rust, so no webview permission is needed.

## 3. Verification

1. **Read-only mode**
   1. Unlock the app and open Trading. The banner says READ-ONLY.
   2. Change the execution mode. The PIN modal appears.
   3. Cancel. Nothing changes, and the audit log gets `read_only_block`.
   4. Change the mode again and enter the PIN. The action goes through, and the banner counts down from 5:00.
   5. Click "Lock now". The banner returns to READ-ONLY.
   6. Repeat with a Finance invoice edit and with Settings → Privacy kill switch OFF.
   7. Muting the mic and switching the compute mode never ask for the PIN.
2. **3-click kill switch** (top bar)
   1. Click once: the button shows ARM → CONFIRM. Wait 4 s: it resets.
   2. Click 3 times quickly: CONFIRM → EXECUTE KILL fires, Lockdown turns on, and the audit gets a critical `kill_switch` entry plus an SMS.
   3. The Trading desk E-stop shows the same ARM / CONFIRM / EXECUTE KILL labels. **Use Dry run only.** The real E-stop cancels orders and flattens positions.
3. **Hourly / idle lock simulation**
   1. In `security.config.json`, set `"session": {"idleLockMinutes": 1, "reauthMinutes": 5}`. It hot-reloads.
   2. Leave the app idle for 1 minute. It locks, and resuming needs Windows Hello (or phone approval) plus the PIN.
   3. Keep using the app. It still locks 5 minutes after the last verification.
   4. Restore the defaults (15 / 60) afterwards.
4. **Remote CLI failsafe**
   - `gabagool-cli emergency-kill --token-env CC_KILL` (or `--token <SECRET>`). Prefer the env form: a literal token ends up in shell history.
   - The app flips to HARD LOCKED within about 1 s.
   - `state.json` shows `hardLocked: true`, and the epoch bumps.
   - `data/trading/TRADING_LOCKED.json` is written. Positions are untouched unless `remoteKill.flattenPositions` is on.
   - You get a CRITICAL `remote_kill` audit entry and an SMS.
   - To release: `gabagool-cli clear-lock` (PIN), then the desk-CLI unlock after a reconcile, then turn the privacy kill switch off in the app.
   - **This locks the live paper desk.** Run it outside market hours, or first point `TRADING_DATA_DIR` and `AGENTIC_OS_SECURITY_DIR` at temp folders.
5. **Remote webhook failsafe**
   - `gabagool-cli sign-webhook` prints a signed curl that is valid for 120 s and executes the kill when sent.
   - From the phone over NetBird: `POST https://<netbird-ip>:8443/api/security/emergency-kill`
     - headers: `X-CC-Timestamp` (unix seconds), `X-CC-Signature: sha256=<hex hmac(secret, "<ts>.<raw body>")>`
     - body: `{"reason":"..."}`
   - These are refused with 401 and audited: a bad signature, a timestamp more than 120 s old, or a replay. Five bad attempts in a minute return 429.
6. **Automated tests**
   - `cargo test --lib security::` (21 Rust tests)
   - `python tests/test_security_layer.py` (11 tests, temp dirs only)
   - `npx vitest run src/features/security` (4 tests)
   - `gabagool-cli audit-verify` checks the hash chain.

## Behaviour notes

- **Startup**
  - The PIN alone unlocks, or Windows Hello / fingerprint alone (`entry.requireSecondFactor` makes both required).
  - There is no in-app PIN setup: without a PIN the app stays locked until you run `gabagool-cli set-pin`.
- **Resume** (idle, hourly, manual or revoked lock)
  - Needs biometric or companion approval (within 2 min) **and** the PIN.
  - If no second factor is reachable, the PIN alone works. That use is audited and alerted as `second_factor_fallback` (`resume.pinFallbackWhenOffline`).
- **Wrong PINs**
  - Unlock and step-up share one counter: 5 in a row → 5 min lockout (critical alert).
- **Hard lock**
  - Applies even with `enabled: false`, and stops the task worker.
  - The app re-engages the privacy kill switch at every start while the hard lock is held.
- **Phone PWA**
  - It has no Rust, so protected modules are read-only there (gateway 423).
  - Loopback scripts without an `Origin` header (trading agent, healthcheck) skip the step-up (`gateway.exemptLoopbackAutomation`), but not the hard lock.
- **Not verified here**
  - The Android/iOS code paths (the biometric plugin and companion signing on the phone) aren't compiled on Windows.
  - Windows Hello was type-checked but not prompted live.
