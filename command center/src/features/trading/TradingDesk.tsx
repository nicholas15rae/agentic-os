import { useEffect, useState } from "react";
import { Loader2, OctagonX, ShieldCheck, ShieldAlert } from "lucide-react";
import { Card, Input } from "@/components/ui";
import { useToasts } from "@/features/reminders/notify";
import { usePoll } from "@/lib/use-poll";
import { tradingApi, type DeskIntent, type DeskView, type ExecMode } from "@/features/trading/ibkr";
import { KILL_CONFIRM_MS, KILL_HOTKEY_LABEL, KILL_PRESSES, summarizeIncident, tripKillSwitch } from "@/features/trading/kill-switch";

const MODES: { id: ExecMode; label: string; hint: string }[] = [
  { id: "ADVISORY", label: "Advisory", hint: "Signals and hypothetical trades only. Nothing is sent." },
  { id: "SEMI_AUTO", label: "Semi-auto", hint: "Approved intents wait as cards for one-click approval (re-checked on approval)." },
  { id: "FULL_AUTO", label: "Full auto", hint: "Approved intents go straight to the paper account, inside the Security Detail caps." },
];

const VERDICT_TONE: Record<string, string> = {
  APPROVED: "text-teal-soft",
  MODIFIED: "text-amber-light",
  REJECTED: "text-alert",
  SUBMITTED: "text-teal-soft",
};

/** Execution controls: E-stop, kill-switch lock/reset, mode switch, SEMI_AUTO trade cards, decisions + audit. */
export function TradingDesk() {
  const { data, error, refresh } = usePoll<DeskView>(tradingApi.desk, 3_000);
  const toast = useToasts((s) => s.push);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmMode, setConfirmMode] = useState<ExecMode | null>(null);
  const [resetText, setResetText] = useState("");

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast({ title: "Trading", body: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const kill = (dryRun: boolean) =>
    run(dryRun ? "dry" : "kill", async () => {
      const r = await tripKillSwitch(dryRun ? "dry run from Trading UI" : "red button in Trading UI (confirmed)", dryRun);
      toast({ title: dryRun ? (r.ok ? "Kill-switch dry run passed" : "Kill-switch dry run found problems") : "Trading LOCKED", body: summarizeIncident(r), tone: dryRun && r.ok ? "info" : "error" });
    });

  // Multi-press: KILL_PRESSES clicks, each within KILL_CONFIRM_MS of the last (the timer restarts on every
  // click); a pause longer than that disarms it. Only the last click fires.
  const [pressed, setPressed] = useState(0);
  const armed = pressed > 0;
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setPressed(0), KILL_CONFIRM_MS);
    return () => window.clearTimeout(t);
  }, [armed, pressed]);
  const pressKill = () => {
    const next = pressed + 1;
    if (next < KILL_PRESSES) return setPressed(next);
    setPressed(0);
    void kill(false);
  };
  const remaining = KILL_PRESSES - pressed;
  const killLabel = !armed ? "KILL SWITCH" : remaining === 1 ? "CONFIRM KILL" : `ARMED · ${remaining} MORE`;

  const locked = !!data?.lock;

  return (
    <Card
      title="Execution desk · Security Detail"
      action={
        <div className="flex items-center gap-2">
          <button
            onClick={() => void kill(true)}
            disabled={!!busy}
            className="pill-glass !h-8 text-[11px]"
            title="Rehearse the E-stop: connects read-only and lists what would be cancelled and flattened. Changes nothing."
          >
            {busy === "dry" ? <Loader2 size={12} className="animate-spin" /> : null} Dry run
          </button>
          {armed && (
            <button onClick={() => setPressed(0)} className="pill-glass !h-8 text-[11px]" aria-label="Cancel kill switch">
              Cancel
            </button>
          )}
          <button
            onClick={pressKill}
            disabled={busy === "kill"}
            aria-label={armed ? `Kill switch armed: ${remaining} more click${remaining === 1 ? "" : "s"} to lock trading, cancel all orders, sell all positions at market` : `Kill switch: click ${KILL_PRESSES} times to lock trading, cancel all orders, flatten all positions`}
            title={armed ? `${remaining} more click${remaining === 1 ? "" : "s"}, each within ${KILL_CONFIRM_MS / 1000} s` : `Kill switch (or ${KILL_HOTKEY_LABEL} ×${KILL_PRESSES}): click ${KILL_PRESSES} times. Locks, cancels all orders, flattens all positions`}
            className={`flex h-10 items-center gap-2 rounded-full border-2 border-alert px-4 text-[13px] font-bold tracking-wide text-white shadow-[0_0_24px_rgba(239,68,68,0.45)] transition-transform hover:scale-[1.03] active:scale-95 ${remaining === 1 && armed ? "animate-pulse bg-alert" : armed ? "bg-alert" : "bg-alert/85"}`}
          >
            {busy === "kill" ? <Loader2 size={16} className="animate-spin" /> : <OctagonX size={16} />}
            {killLabel}
          </button>
        </div>
      }
    >
      {error && <p className="mb-3 text-[12px] text-alert">Desk unreachable: {error}. The kill switch still works — the gateway locks trading itself if the bridge is down.</p>}

      {locked && data?.lock && (
        <div role="alert" className="mb-4 rounded-[14px] border border-alert/60 bg-alert/10 p-3">
          <p className="text-[13px] font-semibold text-alert">TRADING LOCKED — {data.lock.reason}</p>
          <p className="mt-0.5 text-[11px] text-ink-3">
            {new Date(data.lock.at * 1000).toLocaleString()} · by {data.lock.actor} · incident {data.lock.incidentId}. Stays locked across restarts until you reset it.
          </p>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run("reset", async () => {
                await tradingApi.reset(resetText);
                setResetText("");
                toast({ title: "Kill switch reset", body: "Trading unlocked. The desk stays in Advisory until you re-arm it.", tone: "warn" });
              });
            }}
          >
            <Input value={resetText} onChange={(e) => setResetText(e.target.value)} placeholder='Type RESET to unlock' aria-label="Reset confirmation" className="!h-8 !w-48 !py-1 font-mono text-[12px]" />
            <button className="pill-glass !h-8 text-[11px]" disabled={resetText !== "RESET" || !!busy}>
              Unlock
            </button>
          </form>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Execution mode" className="flex rounded-full border border-white/10 bg-black/30 p-0.5">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={data?.mode === m.id}
              title={m.hint}
              disabled={!data || !!busy || (locked && m.id !== "ADVISORY")}
              onClick={() => (m.id === "ADVISORY" ? void run("mode", () => tradingApi.setMode(m.id, false)) : setConfirmMode(m.id))}
              className={`h-8 rounded-full px-3 text-[12px] transition-colors disabled:opacity-40 ${
                data?.mode === m.id ? (m.id === "FULL_AUTO" ? "bg-alert/25 text-ink" : m.id === "SEMI_AUTO" ? "bg-amber/20 text-ink" : "bg-teal/20 text-ink") : "text-ink-3 hover:text-ink"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {data?.agentHalted && <span className="rounded-full border border-alert/50 px-2 py-0.5 text-[11px] text-alert">Agent halted</span>}
        {data && data.posture !== "normal" && <span className="rounded-full border border-amber/50 px-2 py-0.5 text-[11px] text-amber-light">Financer posture: {data.posture}</span>}
        <span className={`ml-auto flex items-center gap-1 text-[11px] ${data?.audit.ok === false ? "text-alert" : "text-ink-3"}`} title={data?.audit.note}>
          {data?.audit.ok === false ? <ShieldAlert size={12} /> : <ShieldCheck size={12} />}
          audit chain {data ? (data.audit.ok ? "verified" : "BROKEN") : "…"}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] text-ink-3">{MODES.find((m) => m.id === data?.mode)?.hint}</p>

      {confirmMode && (
        <div className="mt-3 rounded-[14px] border border-amber/50 bg-amber/10 p-3">
          <p className="text-[12px] text-ink">
            Switch to <b>{MODES.find((m) => m.id === confirmMode)?.label}</b>? {confirmMode === "FULL_AUTO" ? "Intents that pass the Security Detail will be sent to the paper account without asking." : "Approved intents will queue here for your one-click approval."}
          </p>
          <div className="mt-2 flex gap-2">
            <button className="pill-primary !h-8 text-[11px]" onClick={() => void run("mode", async () => (await tradingApi.setMode(confirmMode, true), setConfirmMode(null)))}>
              Confirm
            </button>
            <button className="pill-glass !h-8 text-[11px]" onClick={() => setConfirmMode(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {data?.limits && <LimitsRow limits={data.limits} financer={data.financer} />}
      {data?.limitsError && <p className="mt-2 text-[12px] text-alert">risk_limits.json: {data.limitsError} — every intent is refused until it's fixed.</p>}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="label-caps mb-1.5 text-ink-3">Trade cards awaiting approval ({data?.pending.length ?? 0})</p>
          {data?.pending.length ? (
            <div className="space-y-2">
              {data.pending.map((p) => (
                <TradeCard key={p.intentId} p={p} busy={busy === p.intentId} onApprove={() => void run(p.intentId, async () => {
                  const r = await tradingApi.approve(p.intentId);
                  toast({ title: r.ok ? "Order sent to paper" : `Not sent: ${r.status ?? "error"}`, body: r.error ?? r.decision?.reasons.join(" · ") ?? "", tone: r.ok ? "info" : "warn" });
                })} onReject={() => void run(p.intentId, () => tradingApi.reject(p.intentId))} />
              ))}
            </div>
          ) : (
            <p className="rounded-[12px] border border-dashed border-white/[0.08] px-3 py-4 text-center text-[12px] text-ink-3">
              {data?.mode === "SEMI_AUTO" ? "No cards yet — the Trading Agent's approved intents land here." : "Cards appear in Semi-auto mode."}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <p className="label-caps mb-1.5 text-ink-3">Recent Security Detail decisions</p>
          {data?.recent.length ? (
            <ul className="space-y-1 text-[12px]">
              {data.recent.map((r) => (
                <li key={r.intentId} className="rounded-[10px] border border-white/[0.05] px-2.5 py-1.5" title={r.decision.reasons.join("\n") || "all checks passed"}>
                  <span className={`font-mono text-[11px] ${VERDICT_TONE[r.decision.verdict] ?? ""}`}>{r.decision.verdict}</span>{" "}
                  <span className="font-mono">{r.intent.action} {r.decision.quantity || r.intent.quantity} {r.intent.symbol}</span>{" "}
                  <span className="text-ink-3">· {r.status.replace("_", " ")} · {new Date(r.updated * 1000).toLocaleTimeString()}</span>
                  {r.decision.reasons.length > 0 && <p className="truncate text-[11px] text-ink-3">{r.decision.reasons[0]}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-[12px] border border-dashed border-white/[0.08] px-3 py-4 text-center text-[12px] text-ink-3">No intents evaluated yet.</p>
          )}
        </div>
      </div>

      {data?.audit.tail.length ? (
        <details className="mt-4">
          <summary className="label-caps cursor-pointer text-ink-3">Audit log (last {data.audit.tail.length})</summary>
          <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto font-mono text-[11px]">
            {data.audit.tail.map((a) => (
              <li key={a.id} className="flex gap-2 text-ink-2">
                <span className="text-ink-3">#{a.id} {new Date(a.ts * 1000).toLocaleTimeString()}</span>
                <span>{a.kind}</span>
                <span className={VERDICT_TONE[a.verdict] ?? "text-ink-3"}>{a.verdict}</span>
                <span className="truncate text-ink-3">{a.ref} · {a.actor}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="mt-3 text-[11px] text-ink-3">E-stop: click the red button {KILL_PRESSES} times, or press {KILL_HOTKEY_LABEL} {KILL_PRESSES} times, each within {KILL_CONFIRM_MS / 1000} s (works from any section; Esc cancels the hotkey). Paper account only — port 7497.</p>
    </Card>
  );
}

function LimitsRow({ limits, financer }: { limits: Record<string, number | boolean | null>; financer: DeskView["financer"] }) {
  const items: [string, string][] = [
    ["Risk / trade", `${limits.max_risk_per_trade_pct}% · cap ${limits.max_risk_per_trade_base}`],
    ["Position", `${limits.max_position_pct}%`],
    ["Gross exposure", `${limits.max_gross_exposure_pct}%`],
    ["Max positions", String(limits.max_concurrent_positions)],
    ["Daily loss trip", `${limits.max_daily_loss_pct}%`],
    ["Max spread", `${limits.max_spread_pct}%`],
    ["Cooldown", `${limits.symbol_cooldown_s}s`],
    ["Orders / day", String(limits.max_orders_per_day)],
  ];
  return (
    <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
      {items.map(([k, v]) => (
        <span key={k} className="rounded-full border border-white/[0.08] px-2 py-0.5 text-ink-3">
          {k} <span className="font-mono text-ink-2">{v}</span>
        </span>
      ))}
      {financer.allocation_base ? (
        <span className="rounded-full border border-teal/30 px-2 py-0.5 text-ink-3">
          Financer allocation <span className="font-mono text-ink-2">{financer.allocation_base.toLocaleString()}</span>
        </span>
      ) : null}
    </div>
  );
}

function TradeCard({ p, busy, onApprove, onReject }: { p: DeskIntent; busy: boolean; onApprove: () => void; onReject: () => void }) {
  const i = p.intent;
  const d = p.decision;
  return (
    <div className="rounded-[14px] border border-amber/30 bg-amber/[0.05] p-3">
      <div className="flex items-center gap-2">
        <span className={`font-mono text-[13px] font-semibold ${i.action === "BUY" ? "text-teal-soft" : "text-alert"}`}>
          {i.action} {d.quantity} {i.symbol}
        </span>
        {d.verdict === "MODIFIED" && <span className="text-[11px] text-amber-light">cut from {d.requestedQuantity}</span>}
        <span className="ml-auto font-mono text-[11px] text-ink-3">
          {i.order_type}{i.limit_price ? ` ${i.limit_price}` : ""} · stop {i.stop_loss}{i.take_profit ? ` · tp ${i.take_profit}` : ""}
        </span>
      </div>
      {i.thesis && <p className="mt-1 line-clamp-2 text-[12px] text-ink-2">{i.thesis}</p>}
      <p className="mt-1 text-[11px] text-ink-3">
        risk {d.riskBase?.toFixed(2) ?? "—"} · notional {d.notionalBase?.toFixed(2) ?? "—"} · {i.source}
        {i.citations.length ? ` · ${i.citations.length} citation(s)` : ""}
      </p>
      <div className="mt-2 flex gap-2">
        <button className="pill-primary !h-8 text-[11px]" disabled={busy} onClick={onApprove} title="Re-runs every Security Detail check with fresh data, then sends to paper">
          {busy ? <Loader2 size={12} className="animate-spin" /> : null} Approve
        </button>
        <button className="pill-glass !h-8 text-[11px]" disabled={busy} onClick={onReject}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
