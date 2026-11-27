/**
 * Settings → Security audit trail filters and the lock-timer limits. Pure: unit-tested.
 * Event names come from security/commands.rs, gate.rs, failsafe.rs, the CLI and security_api.py.
 */
import type { AuditEntry } from "./api";

export type AuditFilter = "all" | "logins" | "locks" | "approvals" | "trading" | "settings";

export const AUDIT_FILTERS: { id: AuditFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "logins", label: "Logins" },
  { id: "locks", label: "Locks" },
  { id: "approvals", label: "Approvals" },
  { id: "trading", label: "Trading" },
  { id: "settings", label: "Settings changes" },
];

const LOGINS = new Set(["login_success", "login_failure", "reverify_success", "second_factor_ok", "second_factor_fallback", "pin_lockout", "unknown_device", "app_start"]);
const LOCKS = new Set(["inactivity_lock", "reverify_required", "session_locked", "manual_lock", "session_revoked", "hard_lock", "clear_lock", "remote_kill", "remote_kill_rejected", "kill_switch"]);
const APPROVALS = new Set(["step_up_unlock", "step_up_failure", "step_down", "elevation_expired", "read_only_block", "companion_requested", "companion_approved"]);
const SETTINGS = new Set(["pin_changed", "companion_paired", "companion_pair_qr", "session_config_changed"]);

/** The filter groups one entry belongs to (an entry can be in several, e.g. a trading step-up). */
export function auditGroups(e: Pick<AuditEntry, "event" | "module">): AuditFilter[] {
  const g: AuditFilter[] = [];
  if (LOGINS.has(e.event)) g.push("logins");
  if (LOCKS.has(e.event)) g.push("locks");
  if (APPROVALS.has(e.event) || e.event.includes("approv")) g.push("approvals");
  if (e.module === "trading" || e.event.startsWith("trading_")) g.push("trading");
  if (SETTINGS.has(e.event) || (e.module === "settings" && !APPROVALS.has(e.event))) g.push("settings");
  return g;
}

export function filterAudit<T extends Pick<AuditEntry, "event" | "module">>(entries: T[], f: AuditFilter): T[] {
  return f === "all" ? entries : entries.filter((e) => auditGroups(e).includes(f));
}

/** The Security card's lock-timer ranges (Rust clamps to the same: config.rs IDLE_LOCK_RANGE / REAUTH_RANGE). */
export const IDLE_LOCK_LIMITS = { min: 5, max: 120 } as const;
export const REAUTH_LIMITS = { min: 30, max: 720 } as const;

export function clampMinutes(v: number, lim: { min: number; max: number }): number {
  if (!Number.isFinite(v)) return lim.min;
  return Math.min(lim.max, Math.max(lim.min, Math.round(v)));
}
