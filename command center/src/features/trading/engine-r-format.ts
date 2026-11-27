/**
 * Pure formatting for the Engine R panel (EngineRPanel.contract.ts). No I/O, unit-tested.
 * Model-written text is only ever returned as plain strings for React to escape; nothing here parses it.
 */
import { GatewayError } from "@/lib/gateway";
import type { AuditRow } from "@/features/trading/ibkr";
import { APPROVE_PHRASE, type CompareLabel, type RuleDiff, type RuleParamName, type RuleParams, type RuleScanRow, type SetMetrics } from "@/features/trading/EngineRPanel.contract";

/** rules.PARAM_SCHEMA order (the panel lists parameters and diffs in this order). */
export const PARAM_ORDER: RuleParamName[] = [
  "sma_fast", "sma_slow", "breakout_lookback", "min_rel_volume", "atr_period",
  "stop_atr_mult", "target_atr_mult", "max_atr_pct", "risk_per_trade_pct", "disabled_symbols",
];

export function paramValue(v: RuleParams[RuleParamName] | null | undefined): string {
  if (v == null) return "—";
  if (Array.isArray(v)) return v.length ? v.join(" ") : "none";
  return String(v);
}

export interface DiffLine {
  param: RuleParamName;
  from: string;
  to: string;
}

export function diffLines(diff: RuleDiff | null | undefined): DiffLine[] {
  if (!diff) return [];
  return PARAM_ORDER.filter((k) => diff[k] !== undefined).map((k) => ({ param: k, from: paramValue(diff[k]?.from), to: paramValue(diff[k]?.to) }));
}

export const diffText = (diff: RuleDiff | null | undefined): string => diffLines(diff).map((d) => `${d.param} ${d.from} → ${d.to}`).join(", ");

// ── metrics ──────────────────────────────────────────────────────────────────
export type MetricKey = "trades" | "winRate" | "avgWinR" | "avgLossR" | "maxDrawdownR" | "expectancyR";

export interface MetricRow {
  key: MetricKey;
  label: string;
  /** Which way is better; null = no direction (a trade count is neither). */
  better: "higher" | "lower" | null;
}

export const METRIC_ROWS: MetricRow[] = [
  { key: "trades", label: "Trades", better: null },
  { key: "winRate", label: "Win rate", better: "higher" },
  { key: "avgWinR", label: "Avg win", better: "higher" },
  { key: "avgLossR", label: "Avg loss", better: "higher" }, // a loss closer to 0 R is better
  { key: "maxDrawdownR", label: "Max drawdown", better: "lower" },
  { key: "expectancyR", label: "Expectancy", better: "higher" },
];

const signedR = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}R`;

export function metricText(key: MetricKey, m: SetMetrics | null | undefined): string {
  const v = m?.[key];
  if (v == null) return "—";
  if (key === "trades") return String(v);
  if (key === "winRate") return `${(v * 100).toFixed(0)}%`;
  if (key === "maxDrawdownR") return `${v.toFixed(2)}R`;
  return signedR(v);
}

export type Tone = "better" | "worse" | "same" | null;

/** How the proposed number compares with the current one. Describes the numbers only; it decides nothing. */
export function compareTone(row: MetricRow, current: SetMetrics | null | undefined, proposed: SetMetrics | null | undefined): Tone {
  const a = current?.[row.key];
  const b = proposed?.[row.key];
  if (row.better === null || a == null || b == null) return null;
  if (Math.abs(a - b) < 1e-9) return "same";
  return (row.better === "higher" ? b > a : b < a) ? "better" : "worse";
}

export const VERDICT: Record<CompareLabel, { text: string; tone: "teal" | "alert" | "amber" }> = {
  improves_out_of_sample: { text: "Better on build and on the unseen test set", tone: "teal" },
  worse_out_of_sample: { text: "Not better on the unseen test set", tone: "alert" },
  mixed: { text: "Mixed", tone: "amber" },
};

// ── errors ───────────────────────────────────────────────────────────────────
export type EngineRAction = "approve" | "reject" | "toggle" | "scan" | "evaluate";

/**
 * gateway() reports a refusal as "409 Conflict" without the bridge's reason, so name the likely cause.
 * 423 (step-up) keeps gateway()'s own message ("trading is read-only on this device", "step-up cancelled").
 */
export function errorText(e: unknown, action: EngineRAction): string {
  const msg = e instanceof Error ? e.message : String(e);
  const status = e instanceof GatewayError ? e.status : undefined;
  if (status === 409 && (action === "approve" || action === "reject"))
    return "This change no longer applies: it was already decided, or the parameter has moved since it was written (stale). The list is refreshed.";
  if (status === 403 && action === "approve") return `Refused: type ${APPROVE_PHRASE} exactly to approve.`;
  if (status === 503) return "Engine R isn't running: start (or restart) the trading bridge so it loads Engine R.";
  if (status === 404) return "The gateway doesn't have the Engine R routes yet: restart the gateway.";
  return msg;
}

/** Why GET /api/trading/rules failed, from usePoll's message (it keeps only the text: "404 Not Found", "503 …"). */
export function viewErrorText(msg: string): string {
  if (/^404\b/.test(msg)) return "The gateway doesn't have the Engine R routes yet: restart the gateway so it loads them.";
  if (/^503\b/.test(msg)) return "Engine R unreachable: is the trading bridge running, restarted onto Engine R?";
  return `Engine R unreachable (${msg}).`;
}

// ── audit log ────────────────────────────────────────────────────────────────
// ── scan table rows ─────────────────────────────────────────────────────────
/** Desk outcomes that mean "no trade" for a row Engine R handed to the desk (mirrors trading/rule_engine.py
 *  ENTRY_STATUSES_EXCLUDED / desk_accepted). The row's action stays "submitted" (locked contract); the panel shows
 *  the desk's verdict instead, so a refused order never reads as a trade. */
export const DESK_REFUSED: ReadonlySet<string> = new Set(["rejected", "failed", "expired", "dismissed"]);

const SCAN_TONE: Record<string, string> = { submitted: "text-teal-soft", would_submit: "text-teal-soft", limit_block: "text-alert", no_signal: "text-ink-3", skip: "text-ink-3" };

export interface ScanRowView {
  label: string;
  tone: string;
  /** The desk refused it: the order line is shown struck through, as "not sent". */
  refused: boolean;
  /** Failed, but its cancel couldn't be sent: the order may still be working at TWS (never shown as "not sent"). */
  unsure: boolean;
}

export function scanRowView(r: Pick<RuleScanRow, "action" | "desk">): ScanRowView {
  const st = r.desk?.status;
  if (r.action === "submitted" && st === "failed" && /may still be working/i.test(r.desk?.error ?? ""))
    return { label: "desk failed · may still be working", tone: "text-amber-light", refused: false, unsure: true };
  if (r.action === "submitted" && st && DESK_REFUSED.has(st)) return { label: `desk ${st}`, tone: "text-alert", refused: true, unsure: false };
  return { label: r.action.replace("_", " "), tone: SCAN_TONE[r.action] ?? "text-ink-3", refused: false, unsure: false };
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export interface LogLine {
  text: string;
  /** Full reason for a tooltip, when the line is a shortened form. */
  title?: string;
  /** Contains model-written text (an analyst rationale or review). */
  untrusted: boolean;
}

/** One readable line per RuleEngine.log() row. */
export function logLine(row: AuditRow): LogLine {
  const p = row.payload ?? {};
  const diff = p.diff as RuleDiff | undefined;
  switch (row.kind) {
    case "rule_scan": {
      const taken = strs(p.taken);
      return { text: `${str(p.kind)} scan${p.submit === false ? " (dry run)" : ""}: ${str(p.status)}${str(p.detail) ? ` · ${str(p.detail)}` : ""}${taken.length ? ` · took ${taken.join(" ")}` : ""}`, untrusted: false };
    }
    case "rule_trade": {
      const desk = rec(p.desk);
      return { text: `${str(p.symbol)} ×${str(p.quantity)} @ ${str(p.limit)} · stop ${str(p.stop)} · target ${str(p.target)} · desk ${str(desk.status) || "?"}`, title: str(p.reason), untrusted: false };
    }
    case "rule_limit_block":
      return { text: `${str(p.symbol)}: ${str(p.why)}`, untrusted: false };
    case "rule_change_proposed": {
      const why = rec(p.rationale);
      return { text: `${diffText(diff)} · by ${str(p.source)}`, title: str(why.text), untrusted: why.untrusted === true };
    }
    case "rule_change_approved":
      return { text: `v${str(p.fromVersion)} → v${str(p.toVersion)}: ${diffText(diff)}${str(p.note) ? ` · note: ${str(p.note)}` : ""}`, untrusted: false };
    case "rule_change_rejected":
      return { text: `${diffText(diff)}${str(p.why) ? ` · ${str(p.why)}` : ""}${str(p.note) ? ` · note: ${str(p.note)}` : ""}`, untrusted: false };
    case "ruleset_activated":
      return { text: `v${str(p.version)} active`, title: str(p.reason), untrusted: false };
    case "rule_limits_changed": {
      const changed = Object.entries(rec(p.changed)).map(([k, v]) => `${k} ${str(rec(v).from)} → ${str(rec(v).to)}`);
      return { text: `${changed.join(", ") || "no change"}${str(p.reason) ? ` · ${str(p.reason)}` : ""}`, untrusted: false };
    }
    case "rule_engine_enabled":
      return { text: p.enabled ? "switched ON" : "switched OFF", untrusted: false };
    case "rule_evaluation":
      return { text: `v${str(p.version)} · cutoff ${str(p.cutoff) || "—"} · build ${str(rec(p.build).trades) || 0} / test ${str(rec(p.test).trades) || 0} trades`, untrusted: false };
    case "analyst_run":
      return { text: `${str(p.status)}${str(p.detail) ? ` · ${str(p.detail)}` : ""}`, untrusted: false };
    default: {
      const t = str(p.reason) || str(p.why) || str(p.detail) || str(p.note) || str(p.symbol);
      return { text: t, untrusted: false };
    }
  }
}
