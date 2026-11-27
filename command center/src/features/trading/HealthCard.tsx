import { useState } from "react";
import { ChevronDown, Loader2, Stethoscope } from "lucide-react";
import { Card } from "@/components/ui";
import { useToasts } from "@/features/reminders/notify";
import { usePoll } from "@/lib/use-poll";
import { healthApi, tradingApi, type HealthResult, type HealthStatus, type IbkrStatus } from "@/features/trading/ibkr";
import { reconcileHealth } from "@/features/trading/health-live";

const TONE: Record<HealthStatus, string> = {
  PASS: "border-teal/50 bg-teal/15 text-teal-soft",
  WARN: "border-amber/50 bg-amber/15 text-amber-light",
  FAIL: "border-alert/60 bg-alert/15 text-alert",
  SKIP: "border-white/15 bg-white/[0.04] text-ink-3",
};
const STAGE_ORDER = ["safety", "broker", "data", "gate", "kill_switch", "engines", "intel", "runtime"];

/** Pipeline health: read-only, stage-by-stage. Runs on demand and every trading day 09:00 New York.
 *  The connection row is the LIVE bridge state (same poll + hudLevel as the paper-account card). */
export function HealthCard() {
  const { data, refresh } = usePoll<HealthResult>(healthApi.last, 60_000);
  const live = usePoll<IbkrStatus>(tradingApi.status, 2_000);
  const toast = useToasts((s) => s.push);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState<HealthResult | null>(null);
  const res = reconcileHealth(fresh ?? data, live.data, live.error);
  const problems = res?.checks.filter((c) => c.status === "FAIL" || c.status === "WARN") ?? [];

  const run = async () => {
    setBusy(true);
    try {
      const r = await healthApi.run(true);
      setFresh(r);
      setOpen(r.overall !== "PASS");
      toast({ title: `Health check: ${r.overall}`, body: r.checks.filter((c) => c.status === "FAIL").map((c) => `${c.name}: ${c.detail}`).join("\n") || `${r.counts?.PASS ?? 0} checks passed`, tone: r.overall === "FAIL" ? "error" : r.overall === "WARN" ? "warn" : "info" });
    } catch (e) {
      toast({ title: "Health check", body: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <Card className="!p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Stethoscope size={14} className="text-ink-3" />
        <span className="label-caps text-amber-soft">Pipeline health</span>
        {res?.overall ? (
          <span role="status" aria-label={`Pipeline health ${res.overall}`} className={`rounded-full border px-2.5 py-0.5 fs-11 font-semibold ${TONE[res.overall]}`}>{res.overall}</span>
        ) : (
          <span className="fs-11 text-ink-3">never run</span>
        )}
        {res?.overall && (
          <span className="fs-11 text-ink-3">
            {res.atNy} · {res.counts?.PASS ?? 0} pass · {res.counts?.WARN ?? 0} warn · {res.counts?.FAIL ?? 0} fail
            {problems[0] ? <span className={problems[0].status === "FAIL" ? " text-alert" : " text-amber-light"}> · {problems[0].name}: {problems[0].detail}</span> : null}
          </span>
        )}
        {res?.stale && (
          <span className="rounded-full border border-amber/50 bg-amber/10 px-2 py-0.5 fs-10 text-amber-light" title={res.staleReason}>
            stale · as of {res.asOfNy ?? res.atNy}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {res?.checks.length ? (
            <button className="pill-glass !h-8 fs-11" onClick={() => setOpen(!open)} aria-expanded={open}>
              Details <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
          ) : null}
          <button className="pill-primary !h-8 fs-11" disabled={busy} onClick={() => void run()} title="Read-only: evaluates a synthetic intent in memory, dry-runs the kill switch, scans with submit off. Sends nothing.">
            {busy ? <Loader2 size={12} className="animate-spin" /> : null} {busy ? "Checking…" : "Run check"}
          </button>
        </div>
      </div>
      {open && res?.stale && res.staleReason && <p className="mt-2 fs-11 text-amber-light">{res.staleReason}</p>}
      {open && res && (
        <div className="mt-3 overflow-x-auto r-12 border border-white/[0.06]">
          <table className="w-full fs-12">
            <tbody>
              {[...res.checks].sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)).map((c) => (
                <tr key={`${c.stage}.${c.name}`} className="border-t border-white/[0.04] first:border-t-0">
                  <td className="px-2.5 py-1.5"><span className={`rounded-full border px-1.5 py-0.5 font-mono fs-10 ${TONE[c.status]}`}>{c.status}</span></td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 text-ink-3">{c.stage.replace("_", " ")}</td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 font-mono">{c.name}{c.live ? <span className="ml-1 fs-10 text-teal-soft">live</span> : null}</td>
                  <td className="px-2.5 py-1.5 text-ink-2">{c.detail}</td>
                  <td className="px-2.5 py-1.5 text-right font-mono fs-10 text-ink-3">{c.ms}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
