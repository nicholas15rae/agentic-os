/**
 * Contract for the Rust security layer (src-tauri/src/security/commands.rs). The webview only
 * ever gets status, unlock / step-up results and short-lived elevation tokens; it can't read a
 * PIN hash or key. The desktop PIN is set with `gabagool-cli set-pin`; a phone (no CLI) sets its
 * first PIN in the app (`pinSetup`, refused by Rust on the desktop and once a PIN exists).
 */
import { native, type OsConfig } from "@/lib/platform";

export type LockReason = "startup" | "idle" | "reauth" | "manual" | "revoked" | "hard-lock";
export type Factor = "pin" | "biometric" | "companion";
export type ProtectedModule = "trading" | "finance" | "settings";

export interface SessionView {
  locked: boolean;
  reason: LockReason | null;
  sessionId: string | null;
  verifiedAt: number | null;
  reauthAt: number | null;
  idleAt: number | null;
  needsSecondFactor: boolean;
  secondFactor: Factor | null;
  failures: number;
  lockoutUntil: number | null;
  elevations: { module: string; expiresAt: number }[];
}

export interface ModuleView {
  module: string;
  readOnlyByDefault: boolean;
  elevatedUntil: number | null;
}

export interface SecurityStatus {
  enabled: boolean;
  hardLocked: boolean;
  hardLockReason: string | null;
  pinSet: boolean;
  pinMinLength: number;
  biometricAvailable: boolean;
  companionEnabled: boolean;
  companionPaired: boolean;
  /** Section pass: the paired phone's approval logs in on its own (PIN = fallback). */
  companionUnlocks?: boolean;
  companionDevice: boolean;
  platform: "windows" | "macos" | "linux" | "android" | "ios";
  deviceId: string;
  session: SessionView;
  modules: ModuleView[];
  idleLockMinutes: number;
  reauthMinutes: number;
  elevationIdleMinutes: number;
  elevationMaxMinutes: number;
  /** Section pass: an unlocked session survives an app restart (desktop). */
  persistAcrossRestarts?: boolean;
  /** Rust's clock (unix seconds) when this status was taken. */
  now: number;
}

export interface ElevationGrant {
  module: string;
  token: string;
  expiresAt: number;
}

export const securityApi = {
  status: () => native<SecurityStatus>("security_status"),
  touch: () => native<void>("security_touch"),
  unlockPin: (pin: string) => native<SecurityStatus>("security_unlock_pin", { pin }),
  biometric: () => native<SecurityStatus>("security_biometric"),
  /** No module: approve an unlock. A module: approve a step-up on the paired phone. */
  companionRequest: (module?: string) => native<{ id: string; expiresAt: number; code: string }>("security_companion_request", module ? { module } : {}),
  companionPoll: (id: string) => native<{ state: "pending" | "approved" | "denied" | "expired"; grant?: ElevationGrant }>("security_companion_poll", { id }),
  lock: () => native<SecurityStatus>("security_lock"),
  elevate: (module: string, pin: string) => native<ElevationGrant>("security_elevate", { module, pin }),
  elevationToken: (module: string) => native<ElevationGrant>("security_elevation_token", { module }),
  dropElevation: (module: string) => native<SecurityStatus>("security_drop_elevation", { module }),
  lockdownEngage: (source: string) => native<OsConfig>("security_lockdown_engage", { source }),
  auditRecent: (limit = 50) => native<AuditEntry[]>("security_audit_recent", { limit }),
  /** `code`: the 2-digit number the desktop shows (the signature covers it). */
  companionSign: (id: string, nonce: string, desktop: string, purpose: string, code: string) => native<{ sig: string; deviceId: string }>("security_companion_sign", { id, nonce, desktop, purpose, code }),
  companionCheckAlerts: (alerts: InboxAlert[]) => native<boolean[]>("security_companion_check_alerts", { alerts }),
  pinSetup: (pin: string) => native<SecurityStatus>("security_pin_setup", { pin }),
  /** Phone: a plain key from `gabagool-cli pair-companion`, or the desktop's pairing-QR text (`gbgpair1|…`). */
  companionStoreKey: (key: string) => native<SecurityStatus>("security_companion_store_key", { key }),
  /** Settings → Security: the session timeouts, in minutes (needs a settings step-up). */
  setTimeouts: (timeouts: SessionTimeouts) => native<SecurityStatus>("security_set_timeouts", { timeouts }),
  /** Desktop: a NEW pairing key as a one-time QR payload (replaces the current pairing). Settings step-up. */
  companionPairQr: () => native<{ payload: string; expiresAt: number }>("security_companion_pair_qr"),
  /** Idle lock (5–120 min) and hard re-auth (30–720 min) only → security.config.json. Settings step-up.
   *  (The Security card uses `setTimeouts`, which also covers the step-up windows and restart persistence.) */
  sessionSet: (idleLockMinutes: number, reauthMinutes: number) => native<SecurityStatus>("security_session_set", { idleLockMinutes, reauthMinutes }),
};

/** Rust `commands::Timeouts` (minutes). Clamped there: idle lock 5–120, re-verify 30–720, step-up idle 1–30, step-up max 1–60. */
export interface SessionTimeouts {
  idleLockMinutes: number;
  reauthMinutes: number;
  elevationIdleMinutes: number;
  elevationMaxMinutes: number;
  /** Stay unlocked across app restarts (omit to leave it as it is). */
  persistAcrossRestarts?: boolean;
}

/** A desktop alert waiting in the gateway's companion inbox (`sig` empty = raised by the gateway). */
export interface InboxAlert {
  id: string;
  ts: number;
  event: string;
  severity: "info" | "warn" | "critical";
  title: string;
  body: string;
  device: string;
  sig: string;
}

/** "step_up:trading" → "allow changes to Trading"; anything else is an unlock. */
export function describePurpose(purpose: string): string {
  const m = purpose.startsWith("step_up:") ? purpose.slice(8) : null;
  return m ? `allow changes to ${MODULE_LABEL[m] ?? m}` : `unlock (${purpose})`;
}

export interface AuditEntry {
  ts: string;
  seq: number;
  event: string;
  severity: "info" | "warn" | "critical";
  outcome: "success" | "failure" | "info";
  module: string | null;
  deviceId: string;
  source: string;
  detail: Record<string, unknown>;
}

/** Rust refusals are `CODE[:arg]: message` (session.rs `Refusal::message`, gate.rs). */
export interface SecurityError {
  code: string;
  arg?: string;
  message: string;
}

export function parseSecurityError(e: unknown): SecurityError | null {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  const m = /^([A-Z_]{4,})(?::([^:\s]+))?:\s*(.*)$/s.exec(s);
  return m ? { code: m[1], arg: m[2], message: m[3] } : null;
}

/** Human line for an unlock / step-up failure. */
export function describeSecurityError(e: unknown): string {
  const p = parseSecurityError(e);
  if (!p) return e instanceof Error ? e.message : String(e);
  switch (p.code) {
    case "BAD_PIN":
      return `Wrong PIN — ${p.arg} attempt${p.arg === "1" ? "" : "s"} left before the lockout.`;
    case "LOCKED_OUT":
      return "Too many wrong PINs. Locked out for now.";
    case "SECOND_FACTOR_REQUIRED":
      return "Confirm with biometrics or your phone first, then the PIN.";
    case "PIN_NOT_SET":
      return "No PIN is set yet. Run `gabagool-cli set-pin` in a terminal.";
    case "COMPANION_UNPAIRED":
      return "No phone is paired. Run `gabagool-cli pair-companion` and enter the key on the phone.";
    case "COMPANION_OFFLINE":
      return "Can't reach the gateway mailbox for your phone. Use the PIN.";
    case "PAIR_QR_EXPIRED":
      return "That pairing code has expired. Show a new QR on the desktop (Settings → Security).";
    case "PAIR_QR_BAD":
      return "That pairing code is damaged. Show a new QR on the desktop.";
    default:
      return p.message || p.code;
  }
}

/** Which protected module a gateway path belongs to (a hint; the gateway decides). */
export function gatewayModule(path: string): ProtectedModule | null {
  if (path.startsWith("/api/trading/")) return "trading";
  if (/^\/api\/cc\/c\/(income|goals|invoices|checks|receipts|commissions|mileage|pending|statement_lines)\b/.test(path)) return "finance";
  if (path.startsWith("/api/cc/finance/statement-import")) return "finance";
  if (path.startsWith("/api/cc/config") || path.startsWith("/api/cc/business/profiles")) return "settings";
  return null;
}

export const MODULE_LABEL: Record<string, string> = { trading: "Trading", finance: "Finance", settings: "Settings" };
