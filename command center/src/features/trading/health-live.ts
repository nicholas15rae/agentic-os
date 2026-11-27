/**
 * One connection state everywhere: the Pipeline health card's broker.bridge row is derived from the
 * same live /api/trading/status (and the same hudLevel) as the IBKR paper-account card, so the two can
 * never disagree. The stored run's other rows stay as they were and are marked stale ("as of HH:MM")
 * when the connection changed since the run. Mirrors trading/healthcheck.py with_live_bridge().
 */
import { hudLevel, type HealthCheckRow, type HealthResult, type HealthStatus, type IbkrStatus } from "@/features/trading/ibkr";

const RANK: Record<HealthStatus, number> = { PASS: 0, SKIP: 0, WARN: 1, FAIL: 2 };

export function overallOf(checks: HealthCheckRow[]): HealthStatus {
  const worst = Math.max(0, ...checks.map((c) => RANK[c.status] ?? 0));
  return worst === 2 ? "FAIL" : worst === 1 ? "WARN" : "PASS";
}

/** The live connection row, from the same status + hudLevel the account card shows. */
export function liveBridgeRow(status: IbkrStatus | null, error: string | null, nowS: number): HealthCheckRow {
  const s = error ? null : status;
  const { level, label } = hudLevel(s, nowS);
  if (level === "connected") {
    const acct = s?.account;
    return { stage: "broker", name: "bridge", status: "PASS", ms: 0, live: true,
      detail: `Connected (live) · ${acct?.account ?? "paper"} · client ${s?.clientId ?? "?"} · ${s?.readOnly === false ? "read/write" : "read-only"}` };
  }
  const why = error ? `gateway: ${error}` : s?.downReason || [...(s?.reasons ?? []), s?.lastError].filter(Boolean).join(" · ") || "waiting for TWS on 127.0.0.1:7497";
  return { stage: "broker", name: "bridge", status: "FAIL", ms: 0, live: true, detail: `${label} (live): ${why}` };
}

/** `res` with its connection row replaced by the live one; overall / counts recomputed; stale when it changed. */
export function reconcileHealth(res: HealthResult | null, status: IbkrStatus | null, error: string | null, nowS: number = Date.now() / 1000): HealthResult | null {
  if (!res || !res.overall) return res;
  if (!status && !error) return res; // live state not known yet: show the stored run as is
  const live = liveBridgeRow(status, error, nowS);
  const idx = res.checks.findIndex((c) => c.stage === "broker" && c.name === "bridge");
  const prev = idx >= 0 ? res.checks[idx] : null;
  const checks = res.checks.slice();
  // Keep the server's richer detail when it agrees with the live state.
  const row = prev && prev.status === live.status ? { ...prev, live: true } : live;
  if (idx >= 0) checks[idx] = row;
  else checks.push(row);
  const changed = !prev || prev.status !== live.status;
  const asOf = res.asOfNy ?? res.atNy;
  const stale = Boolean(res.stale) || changed;
  const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 } as Record<HealthStatus, number>;
  for (const c of checks) counts[c.status] = (counts[c.status] ?? 0) + 1;
  return {
    ...res,
    checks,
    overall: overallOf(checks),
    counts,
    asOfNy: asOf,
    stale,
    staleReason: changed
      ? `connection changed since the check at ${asOf} (then ${prev?.status ?? "not checked"}, now ${live.status}): the other rows are as of then; run the check again`
      : res.staleReason,
  };
}
