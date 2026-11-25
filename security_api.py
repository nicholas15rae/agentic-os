"""Gateway side of the Command Center security layer: /api/security/* + the step-up middleware.

The desktop app's Rust core (`command center/src-tauri/src/security`) owns sessions, the PIN
(Argon2id) and elevation. This module is the network edge and mirrors its shared files in
`data/security/` (override: AGENTIC_OS_SECURITY_DIR):

  security.config.json   tunables + the protected HTTP routes per module (written by Rust)
  state.json             {epoch, hardLocked, ...}; unreadable = hard-locked (fail closed)
  elevation.key          HMAC key for elevation tokens (Rust mints, this verifies)
  remote_kill.key        remote failsafe secret (CC_REMOTE_KILL_SECRET overrides)
  security_audit.jsonl   append-only, hash-chained audit (prev = sha256 of the previous line)
  security.lock          cross-process mutex (create-new file) for state + audit writes

Enforcement:
  * StepUpMiddleware: a protected route (config `modules.*.gateway`) needs a valid
    `X-CC-Elevation` token for its module, else 423 {code: STEP_UP_REQUIRED, module}. Hard lock
    → 423 HARD_LOCKED for every protected route. The trading E-stop (/api/trading/kill-switch)
    is never gated. Loopback requests WITHOUT an Origin header (local scripts) are exempt from
    the step-up (not from the hard lock) while `gateway.exemptLoopbackAutomation` is on.
  * POST /api/security/emergency-kill: HMAC-SHA256 signed webhook (phone shortcut / n8n over
    NetBird): hard lock + revoke, trading desk lock, CRITICAL audit, SMS confirmation. Positions
    are NOT touched unless `remoteKill.flattenPositions` is on.
  * Companion mailbox: the desktop posts an approval request, the paired phone signs it; the
    desktop verifies the signature itself (this is only a mailbox).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import smtplib
import ssl
import threading
import time
import urllib.parse
import urllib.request
import uuid
from email.message import EmailMessage
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

BASE_DIR = Path(__file__).resolve().parent
router = APIRouter(prefix="/api/security", tags=["security"])

# Never gated, whatever the config says (safety direction / this module's own routes).
ALWAYS_OPEN = ("/api/trading/kill-switch", "/api/security/")

DEFAULT_RULES: dict[str, list[dict[str, str]]] = {
    "trading": [
        {"method": "POST", "path": "/api/trading/intents*"},
        {"method": "POST", "path": "/api/trading/mode"},
        {"method": "POST", "path": "/api/trading/engines/*"},
        {"method": "POST", "path": "/api/trading/agent/run"},
        {"method": "POST", "path": "/api/trading/agent/enable"},
        {"method": "POST", "path": "/api/trading/kill-switch/reset"},
    ],
    "finance": [{"method": m, "path": f"/api/cc/c/{c}*"} for c in ("income", "goals", "invoices", "checks", "receipts") for m in ("POST", "PATCH", "DELETE")],
    "settings": [{"method": "PUT", "path": "/api/cc/config"}],
}


def sec_dir() -> Path:
    d = os.environ.get("AGENTIC_OS_SECURITY_DIR", "").strip()
    return Path(d) if d else BASE_DIR / "data" / "security"


def _now() -> float:
    return time.time()


# ── shared files ─────────────────────────────────────────────────────────────

class _FileLock:
    """Same protocol as Rust `shared::lock`: create-new `security.lock`, stale after 10 s."""

    def __init__(self, d: Path):
        self.p = d / "security.lock"

    def __enter__(self):
        self.p.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(200):
            try:
                fd = os.open(self.p, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.close(fd)
                return self
            except FileExistsError:
                try:
                    if _now() - self.p.stat().st_mtime > 10:
                        self.p.unlink(missing_ok=True)
                        continue
                except OSError:
                    pass
                time.sleep(0.01)
        raise TimeoutError("security.lock is held")

    def __exit__(self, *exc):
        try:
            self.p.unlink(missing_ok=True)
        except OSError:
            pass


def load_config(d: Path | None = None) -> dict[str, Any]:
    p = (d or sec_dir()) / "security.config.json"
    try:
        cfg = json.loads(p.read_text(encoding="utf-8-sig"))
        return cfg if isinstance(cfg, dict) else {}
    except (OSError, ValueError):
        return {}


def read_state(d: Path | None = None) -> dict[str, Any]:
    p = (d or sec_dir()) / "state.json"
    if not p.exists():
        return {"epoch": 0, "hardLocked": False}
    try:
        s = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(s, dict):
            return s
    except (OSError, ValueError):
        pass
    return {"epoch": 0, "hardLocked": True, "hardLockReason": "unreadable state.json (fail closed)"}


def _write_atomic(p: Path, text: str) -> None:
    tmp = p.with_name(p.name + f".tmp-{uuid.uuid4().hex[:6]}")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(p)


def hard_lock(reason: str, source: str, d: Path | None = None) -> dict[str, Any]:
    d = d or sec_dir()
    with _FileLock(d):
        s = read_state(d)
        s["epoch"] = int(s.get("epoch") or 0) + 1
        if not s.get("hardLocked"):
            s.update(hardLocked=True, hardLockedAt=_now(), hardLockReason=reason[:200], hardLockSource=source[:80])
        s["updatedAt"] = _now()
        _write_atomic(d / "state.json", json.dumps(s, indent=2))
    return s


def _device_id(d: Path) -> str:
    p = d / "device.id"
    try:
        i = p.read_text(encoding="utf-8").strip()
    except OSError:
        i = ""
    if len(i) < 8:
        i = os.urandom(8).hex()
        try:
            p.write_text(i, encoding="utf-8")
        except OSError:
            pass
    host = os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or "device"
    return f"{host}-{i}"


def audit(event: str, severity: str, outcome: str, module: str | None, source: str, detail: dict | None = None, d: Path | None = None) -> dict:
    """Append one hash-chained line (same format as Rust `audit::append_in`), then maybe alert."""
    d = d or sec_dir()
    d.mkdir(parents=True, exist_ok=True)
    path = d / "security_audit.jsonl"
    device = _device_id(d)
    with _FileLock(d):
        prev, seq = "genesis", 0
        try:
            with open(path, "rb") as f:
                f.seek(0, os.SEEK_END)
                f.seek(max(0, f.tell() - 65536))
                lines = [ln for ln in f.read().splitlines() if ln.strip()]
            if lines:
                last = lines[-1]
                prev = hashlib.sha256(last).hexdigest()
                try:
                    seq = int(json.loads(last).get("seq", 0)) + 1
                except ValueError:
                    seq = 0
        except FileNotFoundError:
            pass
        now = _now()
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int((now % 1) * 1000):03d}Z",
            "unix": now, "seq": seq, "event": event, "severity": severity, "outcome": outcome,
            "module": module, "deviceId": device, "source": source, "detail": detail or {}, "prev": prev,
        }
        with open(path, "ab") as f:
            f.write(json.dumps(entry, separators=(",", ":")).encode("utf-8") + b"\n")
    maybe_alert(entry, d)
    return entry


def verify_chain(d: Path | None = None) -> tuple[bool, int]:
    p = (d or sec_dir()) / "security_audit.jsonl"
    prev = None
    n = 0
    try:
        raw = p.read_bytes()
    except FileNotFoundError:
        return True, 0
    for i, ln in enumerate((ln for ln in raw.splitlines() if ln.strip()), 1):
        want = hashlib.sha256(prev).hexdigest() if prev is not None else "genesis"
        if json.loads(ln).get("prev") != want:
            return False, i
        prev = ln
        n += 1
    return True, n


# ── tokens + signatures (mirror of Rust security::token) ─────────────────────

def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _key(d: Path) -> bytes | None:
    try:
        k = bytes.fromhex((d / "elevation.key").read_text(encoding="utf-8").strip())
        return k if len(k) >= 16 else None
    except (OSError, ValueError):
        return None


def verify_token(token: str, module: str, now: float | None = None, d: Path | None = None) -> str | None:
    """None when valid for `module`, else the reason."""
    d = d or sec_dir()
    key = _key(d)
    if not key:
        return "no elevation key"
    parts = token.strip().split(".")
    if len(parts) != 3 or parts[0] != "v1":
        return "malformed"
    try:
        tag = _b64d(parts[2])
        claims = json.loads(_b64d(parts[1]))
    except (ValueError, TypeError):
        return "malformed"
    if not hmac.compare_digest(hmac.new(key, f"v1.{parts[1]}".encode(), hashlib.sha256).digest(), tag):
        return "bad signature"
    if claims.get("m") != module:
        return "wrong module"
    if (now or _now()) >= float(claims.get("exp", 0)):
        return "expired"
    st = read_state(d)
    if st.get("hardLocked"):
        return "hard locked"
    if int(claims.get("ep", -1)) != int(st.get("epoch") or 0):
        return "revoked"
    return None


def remote_kill_secret(d: Path | None = None) -> str | None:
    v = _dotenv("CC_REMOTE_KILL_SECRET")
    if v:
        return v
    try:
        s = ((d or sec_dir()) / "remote_kill.key").read_text(encoding="utf-8").strip()
        return s if len(s) >= 32 else None
    except OSError:
        return None


def webhook_signature(secret: bytes, ts: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret, ts.encode() + b"." + body, hashlib.sha256).hexdigest()


def verify_webhook(secret: bytes, ts: str, body: bytes, sig: str, now: float, max_skew: float) -> str | None:
    try:
        t = float(ts)
    except (TypeError, ValueError):
        return "bad timestamp"
    if abs(now - t) > max_skew:
        return "stale timestamp"
    want = webhook_signature(secret, ts.strip(), body)
    got = sig.strip() if sig.strip().startswith("sha256=") else "sha256=" + sig.strip()
    return None if hmac.compare_digest(want.encode(), got.encode()) else "bad signature"


# ── alerts (mirror of Rust security::alerts; env → .env, no keychain in Python) ──

def _dotenv(key: str) -> str:
    if os.environ.get(key, "").strip():
        return os.environ[key].strip()
    try:
        text = (BASE_DIR / ".env").read_text(encoding="utf-8-sig")
    except OSError:
        return ""
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[7:]
        k, sep, v = line.partition("=")
        if sep and k.strip() == key:
            return v.strip().strip('"').strip("'").strip()
    return ""


_LAST_ALERT: dict[str, float] = {}

_TITLES = {
    "remote_kill": "REMOTE EMERGENCY KILL executed", "remote_kill_rejected": "Rejected remote kill attempt",
    "hard_lock": "HARD LOCK engaged", "trading_kill_switch": "Trading kill switch tripped", "kill_switch": "Kill switch engaged",
}


def maybe_alert(entry: dict, d: Path | None = None) -> threading.Thread | None:
    cfg = load_config(d).get("alerts") or {}
    if cfg.get("enabled") is False:
        return None
    events = cfg.get("events") or ["remote_kill", "remote_kill_rejected", "hard_lock", "trading_kill_switch", "kill_switch"]
    if entry["event"] not in events:
        return None
    critical = entry["severity"] == "critical"
    gap = float(cfg.get("minIntervalSeconds", 30))
    if not critical and _now() - _LAST_ALERT.get(entry["event"], 0) < gap:
        return None
    _LAST_ALERT[entry["event"]] = _now()
    what = _TITLES.get(entry["event"], entry["event"].replace("_", " "))
    reason = (entry.get("detail") or {}).get("reason")
    body = (f"{what}{' [' + entry['module'] + ']' if entry.get('module') else ''}{' — ' + str(reason)[:80] if reason else ''}. "
            f"Device {entry['deviceId']}, source {entry['source']}, {time.strftime('%Y-%m-%d %H:%M:%S')}.")[:300]
    title = f"[Command Center {entry['severity'].upper()}] {what}"
    t = threading.Thread(target=deliver, args=(title, body, entry["event"], entry["severity"], cfg), daemon=True)
    t.start()
    return t


class _Skip(Exception):
    """A channel that isn't configured: skipped silently, not an error."""


def _send_companion(title: str, body: str, event: str, severity: str, d: Path | None = None) -> None:
    # The gateway can't read the desktop keychain, so its own alerts go out unsigned (the phone
    # shows them as "via gateway"); Rust-raised alerts arrive here already signed.
    if not _paired_hint(d):
        raise _Skip("no phone paired")
    inbox_put({"id": secrets.token_hex(12), "ts": int(_now()), "event": event, "severity": severity, "title": title, "body": body, "device": "gateway", "sig": ""})


def _paired_hint(d: Path | None) -> bool:
    # `gabagool-cli pair-companion` leaves a non-secret marker (the key itself is in the keychain).
    base = d or sec_dir()
    return (base / "companion.paired").exists() or (base / "companion.key").exists()


def _send_webhook(title: str, body: str, event: str, severity: str) -> None:
    url = _dotenv("CC_ALERT_WEBHOOK_URL")
    if not url:
        raise _Skip("CC_ALERT_WEBHOOK_URL is not set")
    if not url.startswith(("http://", "https://")):
        raise RuntimeError("CC_ALERT_WEBHOOK_URL is not an http(s) URL")
    payload = json.dumps({"event": event, "title": title, "body": body, "severity": severity, "ts": _now()}).encode()
    req = urllib.request.Request(url, data=payload, method="POST", headers={"Content-Type": "application/json"})
    secret = _dotenv("CC_ALERT_WEBHOOK_SECRET")
    if secret:
        ts = str(int(_now()))
        req.add_header("X-CC-Timestamp", ts)
        req.add_header("X-CC-Signature", webhook_signature(secret.encode(), ts, payload))
    urllib.request.urlopen(req, timeout=10).close()  # noqa: S310 — user-configured endpoint


def _send_twilio(title: str, body: str, event: str, severity: str) -> None:
    sid, tok, frm, to = (_dotenv(k) for k in ("CC_TWILIO_ACCOUNT_SID", "CC_TWILIO_AUTH_TOKEN", "CC_TWILIO_FROM", "CC_ALERT_SMS_TO"))
    if not (sid and tok and frm and to):
        raise _Skip("Twilio variables are not set")
    if not sid.isalnum():
        raise RuntimeError("CC_TWILIO_ACCOUNT_SID is not an account SID")
    data = urllib.parse.urlencode({"To": to, "From": frm, "Body": body}).encode()
    req = urllib.request.Request(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json", data=data, method="POST")
    req.add_header("Authorization", "Basic " + base64.b64encode(f"{sid}:{tok}".encode()).decode())
    urllib.request.urlopen(req, timeout=10).close()  # noqa: S310 — fixed https host


def _send_email(title: str, body: str, event: str, severity: str) -> None:
    host, to = _dotenv("CC_SMTP_HOST"), _dotenv("CC_ALERT_EMAIL_TO")
    frm = _dotenv("CC_ALERT_EMAIL_FROM") or _dotenv("CC_SMTP_USER")
    if not (host and to and frm):
        raise _Skip("SMTP variables are not set")
    port = int(_dotenv("CC_SMTP_PORT") or 587)
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = title, frm, to
    msg.set_content(body)
    ctx = ssl.create_default_context()
    smtp = smtplib.SMTP_SSL(host, port, context=ctx, timeout=15) if port == 465 else smtplib.SMTP(host, port, timeout=15)
    with smtp:
        if port != 465:
            smtp.starttls(context=ctx)
        if _dotenv("CC_SMTP_USER") and _dotenv("CC_SMTP_PASS"):
            smtp.login(_dotenv("CC_SMTP_USER"), _dotenv("CC_SMTP_PASS"))
        smtp.send_message(msg)


_CHANNELS = {"companion": _send_companion, "webhook": _send_webhook, "twilio": _send_twilio, "email": _send_email}


def deliver(title: str, body: str, event: str, severity: str, cfg: dict) -> list[tuple[str, str]]:
    """Channels in `alerts.channels` order until one takes it (all with `fanOut`).
    Unconfigured channels are skipped quietly; alerting never raises into the caller."""
    out: list[tuple[str, str]] = []
    channels = [c for c in (cfg.get("channels") or ["companion", "webhook"]) if c in _CHANNELS]
    for ch in channels:
        try:
            _CHANNELS[ch](title, body, event, severity)
            out.append((ch, "sent"))
            if not cfg.get("fanOut"):
                break
        except _Skip as e:
            out.append((ch, f"skipped ({e})"))
        except Exception as e:  # noqa: BLE001
            out.append((ch, f"failed ({type(e).__name__})"))
    sent = [c for c, r in out if r == "sent"]
    failed = [f"{c}: {r}" for c, r in out if r.startswith("failed")]
    if sent:
        print(f"[security] alert '{event}' sent via {', '.join(sent)}")
    elif failed:
        print(f"[security] alert '{event}' not delivered ({'; '.join(failed)}); it is still in security_audit.jsonl")
    return out


# ── companion alert inbox (the paired phone polls it) ─────────────────────────

_INBOX_MAX = 200
_INBOX_TTL = 7 * 86400
_INBOX_LOCK = threading.Lock()


def _inbox_path(d: Path | None = None) -> Path:
    return (d or sec_dir()) / "companion_inbox.json"


def inbox_read(d: Path | None = None) -> list[dict]:
    try:
        items = json.loads(_inbox_path(d).read_text(encoding="utf-8"))
        return items if isinstance(items, list) else []
    except (OSError, ValueError):
        return []


def inbox_put(item: dict, d: Path | None = None) -> None:
    with _INBOX_LOCK:
        cutoff = _now() - _INBOX_TTL
        items = [i for i in inbox_read(d) if float(i.get("ts", 0)) >= cutoff][-(_INBOX_MAX - 1):]
        items.append(item)
        p = _inbox_path(d)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(items), encoding="utf-8")
        os.replace(tmp, p)


# ── step-up middleware ───────────────────────────────────────────────────────

def _match(rule: dict, method: str, path: str) -> bool:
    if str(rule.get("method", "")).upper() != method:
        return False
    p = str(rule.get("path", ""))
    return path.startswith(p[:-1]) if p.endswith("*") else path == p


def protected_module(method: str, path: str, cfg: dict) -> str | None:
    if path == ALWAYS_OPEN[0] or path.startswith(ALWAYS_OPEN[1]):
        return None
    mods = cfg.get("modules")
    rules = {m: (v or {}).get("gateway", []) for m, v in mods.items()} if isinstance(mods, dict) else DEFAULT_RULES
    for module, rs in rules.items():
        if any(_match(r, method, path) for r in rs or []):
            return module
    return None


def _loopback(host: str) -> bool:
    return host in ("127.0.0.1", "::1", "localhost") or host.startswith("127.")


class StepUpMiddleware(BaseHTTPMiddleware):
    """Added INSIDE the CORS middleware (server.py), so 423s still carry CORS headers."""

    async def dispatch(self, request, call_next):
        method = request.method.upper()
        if method in ("GET", "HEAD", "OPTIONS"):
            return await call_next(request)
        d = sec_dir()
        cfg = load_config(d)
        path = request.url.path
        module = protected_module(method, path, cfg)
        if not module:
            return await call_next(request)
        st = read_state(d)
        if st.get("hardLocked"):
            return JSONResponse({"detail": {"code": "HARD_LOCKED", "module": module, "message": "The remote failsafe locked the Command Center; release it with `gabagool-cli clear-lock`."}}, status_code=423)
        if cfg.get("enabled") is False or _key(d) is None:
            return await call_next(request)
        host = (request.client.host if request.client else "") or ""
        if (cfg.get("gateway") or {}).get("exemptLoopbackAutomation", True) and _loopback(host) and "origin" not in request.headers:
            return await call_next(request)
        tokens = [t.strip() for t in request.headers.get("x-cc-elevation", "").split(",") if t.strip()]
        if any(verify_token(t, module, d=d) is None for t in tokens):
            return await call_next(request)
        return JSONResponse({"detail": {"code": "STEP_UP_REQUIRED", "module": module, "message": f"{module} is read-only; confirm with your PIN in the desktop app."}}, status_code=423)


# ── routes ───────────────────────────────────────────────────────────────────

@router.get("/state")
def security_state():
    d = sec_dir()
    s = read_state(d)
    cfg = load_config(d)
    return {"enabled": cfg.get("enabled", True) and _key(d) is not None, "hardLocked": bool(s.get("hardLocked")), "epoch": int(s.get("epoch") or 0)}


_SEEN_SIGS: dict[str, float] = {}
_BAD: dict[str, list[float]] = {}


def _trading_dir() -> Path:
    return Path(os.environ.get("TRADING_DATA_DIR") or BASE_DIR / "data" / "trading")


def write_trading_lock(reason: str, actor: str, incident: str) -> bool:
    """Same file + format as trading_api._write_lock_failsafe / Rust failsafe; never replaces a held lock."""
    d = _trading_dir()
    d.mkdir(parents=True, exist_ok=True)
    p = d / "TRADING_LOCKED.json"
    if p.exists():
        return False
    _write_atomic(p, json.dumps({"locked": True, "at": _now(), "reason": reason, "actor": actor, "incidentId": incident, "source": "security-failsafe"}, indent=2))
    return True


@router.post("/emergency-kill")
async def emergency_kill(request: Request):
    """Remote failsafe. Auth = HMAC-SHA256 over `<ts>.<raw body>` with the remote-kill secret
    (X-CC-Timestamp + X-CC-Signature); no session or gateway token needed."""
    d = sec_dir()
    cfg = load_config(d)
    rk = cfg.get("remoteKill") or {}
    host = (request.client.host if request.client else "") or "?"
    src = f"webhook:{host}"
    if rk.get("enabled") is False:
        raise HTTPException(404, "remote kill is disabled")
    now = _now()
    window = [t for t in _BAD.get(host, []) if now - t < 60]
    if len(window) >= 5:
        raise HTTPException(429, "too many bad signatures; wait a minute")
    secret = remote_kill_secret(d)
    if not secret:
        raise HTTPException(503, "no remote-kill secret configured (run `gabagool-cli init`)")
    body = await request.body()
    ts = request.headers.get("x-cc-timestamp", "")
    sig = request.headers.get("x-cc-signature", "")
    why = verify_webhook(secret.encode(), ts, body, sig, now, float(rk.get("maxSkewSeconds", 120)))
    if why is None and sig in _SEEN_SIGS:
        why = "replayed signature"
    if why:
        _BAD[host] = window + [now]
        audit("remote_kill_rejected", "critical", "failure", None, src, {"reason": why}, d)
        raise HTTPException(401, f"rejected: {why}")
    for k, t in list(_SEEN_SIGS.items()):
        if now - t > 900:
            _SEEN_SIGS.pop(k, None)
    _SEEN_SIGS[sig] = now
    try:
        reason = str((json.loads(body or b"{}") or {}).get("reason") or "remote webhook")[:200]
    except (ValueError, AttributeError):
        reason = "remote webhook"
    incident = "sec-" + time.strftime("%Y%m%d-%H%M%S")
    steps = []
    try:
        s = hard_lock(reason, src, d)
        steps.append({"step": "revoke-sessions", "ok": True, "detail": f"hard lock on, epoch {s['epoch']}"})
    except Exception as e:  # noqa: BLE001
        steps.append({"step": "revoke-sessions", "ok": False, "detail": type(e).__name__})
    try:
        wrote = write_trading_lock(f"remote failsafe: {reason}", src, incident)
        steps.append({"step": "trading-lock", "ok": True, "detail": "desk lock written" if wrote else "desk lock already held"})
    except OSError as e:
        steps.append({"step": "trading-lock", "ok": False, "detail": type(e).__name__})
    if rk.get("flattenPositions"):
        try:
            import trading_api  # noqa: PLC0415 — only on the opt-in path
            trading_api._bridge_post("/kill-switch", {"reason": f"remote failsafe: {reason}", "dryRun": False}, src, timeout=45.0)
            steps.append({"step": "positions", "ok": True, "detail": "cancel + flatten started"})
        except Exception as e:  # noqa: BLE001
            steps.append({"step": "positions", "ok": False, "detail": f"E-stop unreachable ({type(e).__name__}); the desk lock still holds"})
    else:
        steps.append({"step": "positions", "ok": True, "detail": "left untouched (remoteKill.flattenPositions is off)"})
    ok = all(s["ok"] for s in steps if s["step"] != "positions")
    audit("remote_kill", "critical", "success" if ok else "failure", "trading", src, {"reason": reason, "incidentId": incident, "steps": steps}, d)
    return {"ok": ok, "incidentId": incident, "steps": steps}


# Companion mailbox: id → request (+ response). In memory: requests live ≤ 10 min.
_COMPANION: dict[str, dict[str, Any]] = {}
_COMPANION_LOCK = threading.Lock()


def _gc():
    now = _now()
    for k, v in list(_COMPANION.items()):
        if now > float(v.get("expiresAt", 0)) + 60:
            _COMPANION.pop(k, None)


def _require_loopback(request: Request):
    host = (request.client.host if request.client else "") or ""
    if not _loopback(host):
        raise HTTPException(403, "desktop (loopback) only")


@router.post("/companion/request")
async def companion_request(request: Request):
    _require_loopback(request)
    b = await request.json()
    rid, nonce = str(b.get("id", "")), str(b.get("nonce", ""))
    if not (8 <= len(rid) <= 64 and rid.isalnum() and 8 <= len(nonce) <= 64 and nonce.isalnum()):
        raise HTTPException(400, "bad request id / nonce")
    exp = min(float(b.get("expiresAt") or 0), _now() + 600)
    with _COMPANION_LOCK:
        _gc()
        _COMPANION[rid] = {"id": rid, "nonce": nonce, "device": str(b.get("device", ""))[:80], "purpose": str(b.get("purpose", ""))[:40], "expiresAt": exp, "createdAt": _now(), "state": "pending"}
    return {"ok": True}


@router.get("/companion/pending")
def companion_pending():
    now = _now()
    with _COMPANION_LOCK:
        _gc()
        return {"requests": [{k: v[k] for k in ("id", "nonce", "device", "purpose", "expiresAt")} for v in _COMPANION.values() if v["state"] == "pending" and now <= v["expiresAt"]]}


@router.post("/companion/respond")
async def companion_respond(request: Request):
    b = await request.json()
    rid = str(b.get("id", ""))
    with _COMPANION_LOCK:
        r = _COMPANION.get(rid)
        if not r or r["state"] != "pending" or _now() > r["expiresAt"]:
            raise HTTPException(404, "no such pending request")
        if b.get("approve"):
            sig, dev = str(b.get("sig", ""))[:128], str(b.get("deviceId", ""))[:80]
            if not sig or not dev:
                raise HTTPException(400, "sig and deviceId required")
            r.update(state="approved", sig=sig, deviceId=dev)
        else:
            r.update(state="denied")
    return {"ok": True}


@router.get("/companion/result/{rid}")
def companion_result(rid: str, request: Request):
    _require_loopback(request)
    with _COMPANION_LOCK:
        r = _COMPANION.get(rid)
        if not r or (_now() > r["expiresAt"] and r["state"] == "pending"):
            return {"state": "expired"}
        out = {"state": r["state"]}
        if r["state"] == "approved":
            out.update(sig=r["sig"], deviceId=r["deviceId"])
        if r["state"] != "pending":
            _COMPANION.pop(rid, None)  # one-shot
        return out


@router.post("/companion/alert")
async def companion_alert(request: Request):
    """Desktop Rust queues a signed alert for the phone (loopback only)."""
    _require_loopback(request)
    b = await request.json()
    rid = str(b.get("id", ""))
    if not (8 <= len(rid) <= 64 and rid.isalnum()):
        raise HTTPException(400, "bad alert id")
    item = {"id": rid, "ts": int(b.get("ts") or _now()), "event": str(b.get("event", ""))[:60], "severity": str(b.get("severity", "info"))[:10],
            "title": str(b.get("title", ""))[:200], "body": str(b.get("body", ""))[:400], "device": str(b.get("device", ""))[:80], "sig": str(b.get("sig", ""))[:128]}
    inbox_put(item)
    return {"ok": True}


@router.get("/companion/alerts")
def companion_alerts(since: float = 0, limit: int = 50):
    """The phone polls this (NetBird + gateway token); newest last."""
    items = [i for i in inbox_read() if float(i.get("ts", 0)) > since]
    return {"alerts": items[-max(1, min(limit, _INBOX_MAX)):], "now": _now()}
