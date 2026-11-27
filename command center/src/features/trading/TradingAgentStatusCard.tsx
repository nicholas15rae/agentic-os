import { ShieldCheck, ShieldAlert } from "lucide-react";
import { shortModel, useTradingAgent } from "@/features/trading/useTradingAgent";

const MODE_LABEL: Record<string, string> = {
  ADVISORY: "1-week ADVISORY (paper, non-executing)",
  SEMI_AUTO: "Semi-auto (paper, you approve each trade)",
  FULL_AUTO: "Full-auto (paper, within the caps)",
};

/**
 * The Trading Agent's active configuration (System Map → Deep Inspector). Read-only: on/off and
 * runs live in the Trading section's Agent panel. Everything comes from GET /api/trading/agent.
 */
export function TradingAgentStatusCard() {
  const { view, error } = useTradingAgent(20_000);
  if (!view) {
    return (
      <section className="rounded-[12px] border border-white/[0.07] p-3 text-[12px] text-ink-3" aria-label="Trading Agent status">
        {error ? `Gateway unreachable — ${error}` : "Loading the Trading Agent…"}
      </section>
    );
  }
  const c = view.config;
  const now = Date.now() / 1000;
  const daysLeft = c.advisoryEnd ? Math.max(0, Math.ceil((c.advisoryEnd - now) / 86400)) : null;
  const iso = c.isolation.localhostOnly;
  const rows: [string, string][] = [
    ["Model", `${shortModel(c.model)} · local (LM Studio, shares Tony's GPU)`],
    ["Schedule", c.schedule],
    ["Universe", `ETFs + commodity ETFs: ${c.universe.join(" ")}`],
    ["Mode", `${MODE_LABEL[c.deskMode] ?? c.deskMode}${c.deskMode === "ADVISORY" && daysLeft != null ? ` · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : ""}`],
    ["Status", `${view.enabled ? "ON" : "OFF"}${view.enabled && view.nextSlot ? ` · next run ${view.nextSlot}` : ""}${view.blocked ? ` · blocked: ${view.blocked}` : ""}`],
    ["Peer", "Financer only (capital, budget, P&L); Tony can't dispatch to it"],
    ["Risk gate", "Security Detail: deterministic, sizes and can veto every proposal"],
  ];
  return (
    <section className="rounded-[12px] border border-lime-500/30 bg-lime-500/[0.04] p-3" aria-label="Trading Agent status">
      <p className="label-caps mb-2 text-lime-300">Trading Agent · active configuration</p>
      <dl className="grid grid-cols-[84px_1fr] gap-x-2 gap-y-1 text-[12px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-3">{k}</dt>
            <dd className="text-ink-2">{v}</dd>
          </div>
        ))}
      </dl>
      <p className={`mt-2 flex items-center gap-1.5 text-[11.5px] ${iso === false ? "text-amber-light" : iso ? "text-teal-soft" : "text-ink-3"}`}>
        {iso === false ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
        Broker {c.isolation.broker}:{" "}
        {iso === true ? "localhost-only (verified by the health check)" : iso === false ? "reachable from the network: see Pipeline health" : "not verified yet (run the health check)"}
      </p>
    </section>
  );
}
