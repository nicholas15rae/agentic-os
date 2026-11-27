import { useEffect, useState } from "react";
import { Lock, LockOpen, ShieldCheck, ShieldAlert } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import { isTauri } from "@/lib/platform";
import { useArbiter } from "./arbiter-store";
import { acmd, type HealthReport, type VaultStatus } from "./api";
import { fmtGb, fmtMs } from "./agent-graph";

/** HUD refresh while visible (the snapshot reads cached GPU data: no nvidia-smi per poll). */
const POLL_MS = 2000;

function Bar({ label, used, total, unit, warnAt = 0.92 }: { label: string; used: number | null | undefined; total: number | null | undefined; unit: string; warnAt?: number }) {
  const pct = used != null && total ? Math.min(1, used / total) : null;
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between fs-11">
        <span className="label-caps text-ink-3">{label}</span>
        <span className={`font-mono ${pct != null && pct >= warnAt ? "text-amber-light" : "text-ink-2"}`}>
          {used == null ? "—" : `${used} / ${total ?? "—"} ${unit}`}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
        <div className={`h-full rounded-full ${pct != null && pct >= warnAt ? "bg-amber" : "bg-teal"}`} style={{ width: `${(pct ?? 0) * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * Real hardware + hand-off telemetry: VRAM (RTX, used / total), RAM, CPU, Tony's context size
 * (≈ chars / 4, labelled), the token holder, Away Mode, Tony's end-to-end latency and the token
 * turnaround (p50 / p95), the rolling hand-off feed, the memory tiers, the Finance vault and the
 * engine health check. Nothing here is mocked: a missing source reads "—".
 */
export function ArbiterHud({ className = "" }: { className?: string }) {
  const snap = useArbiter((s) => s.snap);
  useEffect(() => void useArbiter.getState().start(), []);
  usePoll(() => (isTauri() ? useArbiter.getState().refresh() : Promise.resolve()), POLL_MS);
  const health = usePoll<HealthReport | null>(() => (isTauri() ? acmd("system_health") : Promise.resolve(null)), 15_000);
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (isTauri()) void acmd("finance_vault_status").then(setVault, () => undefined);
  }, [snap?.vaultOpen]);

  if (!snap) return <div className={`r-14 border border-white/10 p-3 fs-12 text-ink-3 ${className}`}>Telemetry HUD: desktop only.</div>;
  const hw = snap.hardware;
  const gpu = hw?.gpu;
  const vaultToggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (vault?.open) await acmd("finance_vault_lock");
      else await acmd("finance_vault_unlock");
      setVault(await acmd("finance_vault_status"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const h = health.data;
  return (
    <section aria-label="Telemetry HUD" className={`space-y-2 r-14 border border-holo/20 bg-[rgba(4,8,13,0.7)] p-3 ${className}`}>
      <div className="flex items-center gap-2">
        <span className="label-caps text-holo">Telemetry</span>
        {h && (
          <span title={h.ok ? "Engine health: ok" : "Engine health: see the checks below"} className={`ml-auto flex items-center gap-1 fs-11 ${h.ok ? "text-teal" : "text-amber-light"}`}>
            {h.ok ? <ShieldCheck size={12} aria-hidden /> : <ShieldAlert size={12} aria-hidden />} {h.ok ? "healthy" : "check"}
          </span>
        )}
      </div>
      <Bar label={gpu ? `VRAM · ${gpu.name.replace(/^NVIDIA GeForce /, "")}` : "VRAM"} used={gpu ? Number(fmtGb(gpu.vramUsedMb)) : null} total={gpu ? Number(fmtGb(gpu.vramTotalMb)) : null} unit="GB" />
      <Bar label="System RAM" used={hw ? Number(fmtGb(hw.ramUsedMb)) : null} total={hw ? Number(fmtGb(hw.ramTotalMb)) : null} unit="GB" warnAt={0.9} />
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 fs-11">
        <dt className="text-ink-3">GPU util / CPU</dt>
        <dd className="text-right font-mono text-ink-2">{gpu ? `${Math.round(gpu.utilPct)}%` : "—"} / {hw ? `${Math.round(hw.cpuPct)}%` : "—"}</dd>
        <dt className="text-ink-3">Token holder</dt>
        <dd className="text-right font-mono text-teal">{snap.holder ?? "free"}{snap.queued.length ? ` (+${snap.queued.length} queued)` : ""}</dd>
        <dt className="text-ink-3">Away Mode</dt>
        <dd className={`text-right font-mono ${snap.away ? "text-alert" : "text-ink-2"}`}>{snap.away ? "ON" : "off"}</dd>
        <dt className="text-ink-3" title="Tony's last prompt: characters / 4">Context tokens ≈</dt>
        <dd className="text-right font-mono text-ink-2">{snap.contextTokens?.toLocaleString() ?? "—"}</dd>
        <dt className="text-ink-3">Tony e2e p50 / p95</dt>
        <dd className="text-right font-mono text-ink-2">{fmtMs(snap.latency.tony.p50)} / {fmtMs(snap.latency.tony.p95)}</dd>
        <dt className="text-ink-3">Token turnaround p50 / p95</dt>
        <dd className="text-right font-mono text-ink-2">{fmtMs(snap.latency.turnaround.p50)} / {fmtMs(snap.latency.turnaround.p95)}</dd>
      </dl>
      {snap.memory && (
        <div className="fs-11">
          <div className="label-caps mb-0.5 text-ink-3">Memory · active RAG / module</div>
          <div className="flex flex-wrap gap-1">
            {snap.memory.map((m) => (
              <span key={m.namespace} className="rounded-full border border-white/10 px-2 py-0.5 font-mono text-ink-2" title={`${m.activeKb} KB in RAM`}>
                {m.namespace} {m.active}/{m.archived}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 fs-11">
        <span className="label-caps text-ink-3">Finance vault</span>
        <span className={vault?.open ? "text-amber-light" : "text-violet-300"}>{vault ? (vault.open ? `open · ${vault.entries ?? 0} entries` : "sealed") : "—"}</span>
        <button type="button" disabled={busy || !vault} onClick={() => void vaultToggle()} className="ml-auto flex h-6 items-center gap-1 rounded-full border border-violet-400/40 px-2 text-violet-200 hover:bg-violet-500/10 disabled:opacity-50">
          {vault?.open ? <Lock size={11} aria-hidden /> : <LockOpen size={11} aria-hidden />} {vault?.open ? "Seal" : "Unlock"}
        </button>
      </div>
      {err && <p className="fs-11 text-alert">{err}</p>}
      {h && !h.ok && (
        <ul className="space-y-0.5 fs-11 text-amber-light">
          {!h.garbageDaemon.ok && <li>Garbage daemon: no heartbeat yet</li>}
          {h.financeVault.checks.filter((c) => !c.pass).map((c) => (
            <li key={c.check}>Vault: {c.check} ({c.detail})</li>
          ))}
        </ul>
      )}
      <div>
        <div className="label-caps mb-0.5 fs-11 text-ink-3">Hand-offs (live)</div>
        <ol className="max-h-40 space-y-0.5 overflow-auto font-mono fs-10.5">
          {snap.feed.slice(0, 25).map((f, i) => (
            <li key={`${f.at}-${i}`} className="flex gap-2 text-ink-2">
              <span className="shrink-0 text-ink-3">{new Date(f.at).toLocaleTimeString([], { hour12: false })}</span>
              <span className={`shrink-0 ${f.kind === "token" ? "text-teal" : f.kind.startsWith("memory") ? "text-amber-light" : "text-ink-2"}`}>
                {f.from} → {f.to}
              </span>
              <span className="truncate text-ink-3">{f.label}</span>
              {f.ms != null && <span className="ml-auto shrink-0 text-ink-3">{fmtMs(f.ms)}</span>}
            </li>
          ))}
          {!snap.feed.length && <li className="text-ink-3">No hand-offs yet this session.</li>}
        </ol>
      </div>
    </section>
  );
}
