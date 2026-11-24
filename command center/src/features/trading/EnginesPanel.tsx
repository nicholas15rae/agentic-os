import { useState } from "react";
import { Loader2, Play, Plus, Radar, Send, ShieldCheck, X } from "lucide-react";
import { Card, Chip, Input, Select } from "@/components/ui";
import { useToasts } from "@/features/reminders/notify";
import { usePoll } from "@/lib/use-poll";
import { enginesApi, type EnginesView, type OptionsProposal, type ScanRow } from "@/features/trading/ibkr";

const VERDICT_TONE: Record<string, string> = { APPROVED: "text-teal-soft", MODIFIED: "text-amber-light", REJECTED: "text-alert" };
const AUTO = [0, 5, 15, 30, 60];

/**
 * Engine A (ETFs / commodities) and Engine B (defined-risk options). Engines only
 * SUBMIT OrderIntents; the Security Detail and the desk's mode decide what happens.
 * "Scan" / "Propose" alone never reaches the desk.
 */
export function EnginesPanel() {
  const { data, refresh } = usePoll<EnginesView>(enginesApi.view, 10_000);
  const toast = useToasts((s) => s.push);
  const [busy, setBusy] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanRow[] | null>(null);
  const [addSym, setAddSym] = useState("");
  const [addReason, setAddReason] = useState("");
  const [opt, setOpt] = useState({ symbol: "SPY", view: "auto", structure: "vertical" });
  const [proposal, setProposal] = useState<OptionsProposal | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast({ title: "Engines", body: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const rows = scan ?? data?.lastScan?.rows ?? [];
  const prop = proposal ?? data?.lastOptions ?? null;

  return (
    <Card title="Engines · A: ETFs & commodities · B: options">
      <div className="grid gap-5 xl:grid-cols-2">
        {/* ── Engine A ─────────────────────────────────────────────── */}
        <section className="min-w-0" aria-label="Engine A">
          <div className="flex flex-wrap items-center gap-2">
            <p className="label-caps text-ink-3">Engine A · trend breakout</p>
            <div className="ml-auto flex items-center gap-1.5">
              <button className="pill-glass !h-8 text-[11px]" disabled={!!busy} title="Score the watchlist. Nothing is sent." onClick={() => void run("scan", async () => {
                const r = await enginesApi.scan(false);
                if (!r.ok) throw new Error(r.error ?? "scan failed");
                setScan(r.rows);
              })}>
                {busy === "scan" ? <Loader2 size={12} className="animate-spin" /> : <Radar size={12} />} Scan
              </button>
              <button className="pill-primary !h-8 text-[11px]" disabled={!!busy} title="Scan and send every live setup to the desk (Security Detail + current mode)" onClick={() => void run("scan-submit", async () => {
                const r = await enginesApi.scan(true);
                if (!r.ok) throw new Error(r.error ?? "scan failed");
                setScan(r.rows);
                const sent = r.rows.filter((x) => x.desk);
                toast({ title: "Engine A", body: sent.length ? `${sent.length} setup(s) sent to the desk` : "No live setups right now", tone: "info" });
              })}>
                {busy === "scan-submit" ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Scan &amp; submit
              </button>
              <Select
                aria-label="Auto-scan interval"
                value={data?.autoScanMinutes ?? 0}
                onChange={(e) => void run("auto", async () => void (await enginesApi.setAuto(Number(e.target.value))))}
                className="!h-8 !w-auto !py-0 text-[11px]"
                title="Auto scan & submit during regular hours. Stops while locked or halted."
              >
                {AUTO.map((m) => (
                  <option key={m} value={m}>{m ? `auto ${m}m` : "auto off"}</option>
                ))}
              </Select>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {(data?.watchlist ?? []).map((s) => {
              const dyn = data?.watchlistRows.find((r) => r.symbol === s);
              return (
                <span key={s} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] ${dyn ? "border-teal/40 text-teal-soft" : "border-white/10 text-ink-2"}`} title={dyn ? `${dyn.source}: ${dyn.reason}` : "core universe"}>
                  {s}
                  {dyn && (
                    <button aria-label={`Remove ${s}`} onClick={() => void run(`rm-${s}`, async () => void (await enginesApi.removeWatch(s)))} className="text-ink-3 hover:text-alert">
                      <X size={10} />
                    </button>
                  )}
                </span>
              );
            })}
          </div>
          <form
            className="mt-2 flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const s = addSym.trim().toUpperCase();
              if (!s) return;
              void run("add", async () => {
                const r = await enginesApi.addWatch(s, addReason || "added from the Trading UI");
                toast({ title: r.status === "active" ? `${r.symbol} added` : `${r.symbol} rejected`, body: r.problems.join(" · ") || "passed the liquidity prefilter", tone: r.status === "active" ? "info" : "warn" });
                setAddSym("");
                setAddReason("");
              });
            }}
          >
            <Input value={addSym} onChange={(e) => setAddSym(e.target.value)} placeholder="Ticker" aria-label="Add ticker" className="!h-8 !w-24 !py-1 font-mono text-[12px] uppercase" />
            <Input value={addReason} onChange={(e) => setAddReason(e.target.value)} placeholder="Why (catalyst, RAG note…)" aria-label="Reason" className="!h-8 !py-1 text-[12px]" />
            <button className="pill-glass !h-8 !px-2.5 text-[11px]" disabled={busy === "add"} title="Liquidity prefilter: price ≥ $5, ≥ $50M/day, spread ≤ 0.10%">
              {busy === "add" ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            </button>
          </form>

          <div className="mt-3 overflow-x-auto rounded-[12px] border border-white/[0.06]">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-ink-3">
                  {["Symbol", "Setup", "20d mom", "Rel vol", "Desk"].map((h) => (
                    <th key={h} className="px-2.5 py-1.5 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="font-mono tabular">
                {rows.length ? (
                  rows.map((r) => (
                    <tr key={r.symbol} className="border-t border-white/[0.04]" title={r.desk?.reasons.join("\n") || r.why}>
                      <td className="px-2.5 py-1.5">{r.symbol}</td>
                      <td className={`px-2.5 py-1.5 ${r.signal ? "text-teal-soft" : "text-ink-3"}`}>{r.signal ? "BREAKOUT" : r.why.replace("no setup: ", "—  ").slice(0, 34)}</td>
                      <td className="px-2.5 py-1.5">{r.momentum20 != null ? `${r.momentum20.toFixed(1)}%` : "—"}</td>
                      <td className="px-2.5 py-1.5">{r.relVolume != null ? `${r.relVolume.toFixed(2)}×` : "—"}</td>
                      <td className={`px-2.5 py-1.5 ${VERDICT_TONE[r.desk?.verdict ?? ""] ?? "text-ink-3"}`}>{r.desk ? `${r.desk.verdict ?? r.desk.error ?? "—"} · ${r.desk.status ?? ""}` : r.intent ? "not sent" : "—"}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="px-2.5 py-4 text-center text-ink-3">No scan yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Engine B ─────────────────────────────────────────────── */}
        <section className="min-w-0" aria-label="Engine B">
          <p className="label-caps text-ink-3">Engine B · defined-risk options</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Input value={opt.symbol} onChange={(e) => setOpt({ ...opt, symbol: e.target.value.toUpperCase() })} aria-label="Underlying" className="!h-8 !w-20 !py-1 font-mono text-[12px]" />
            <Select value={opt.view} onChange={(e) => setOpt({ ...opt, view: e.target.value })} aria-label="View" className="!h-8 !w-auto !py-0 text-[11px]">
              <option value="auto">view: auto (Engine A trend)</option>
              <option value="bullish">bullish (calls)</option>
              <option value="bearish">bearish (puts)</option>
            </Select>
            <div className="flex gap-1">
              {(["single", "vertical"] as const).map((s) => (
                <Chip key={s} active={opt.structure === s} onClick={() => setOpt({ ...opt, structure: s })}>
                  {s === "single" ? "Long option" : "Debit vertical"}
                </Chip>
              ))}
            </div>
            <div className="ml-auto flex gap-1.5">
              <button className="pill-glass !h-8 text-[11px]" disabled={!!busy} onClick={() => void run("prop", async () => {
                const r = await enginesApi.propose(opt.symbol, opt.view, opt.structure, false);
                if (!r.ok) throw new Error(r.error ?? "propose failed");
                setProposal(r);
              })}>
                {busy === "prop" ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Propose
              </button>
              <button className="pill-primary !h-8 text-[11px]" disabled={!!busy} onClick={() => void run("prop-submit", async () => {
                const r = await enginesApi.propose(opt.symbol, opt.view, opt.structure, true);
                if (!r.ok) throw new Error(r.error ?? "propose failed");
                setProposal(r);
              })}>
                {busy === "prop-submit" ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Propose &amp; submit
              </button>
            </div>
          </div>

          {prop && <ProposalCard p={prop} />}

          {data?.optionLimits && (
            <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
              {[
                ["Premium / trade", `${data.optionLimits.max_premium_pct}% · cap ${data.optionLimits.max_premium_base}`],
                ["DTE", `${data.optionLimits.min_dte}–${data.optionLimits.max_dte}`],
                ["Delta", `${data.optionLimits.target_delta_min}–${data.optionLimits.target_delta_max}`],
                ["OI / vol", `≥${data.optionLimits.min_open_interest} / ≥${data.optionLimits.min_volume}`],
                ["Spread", `≤${data.optionLimits.max_spread_pct}%`],
                ["Stop / target", `−${data.optionLimits.stop_loss_pct}% / +${data.optionLimits.take_profit_pct}%`],
                ["Flatten", `DTE ≤ ${data.optionLimits.flatten_dte}`],
                ["Max lines", String(data.optionLimits.max_option_positions)],
              ].map(([k, v]) => (
                <span key={k} className="rounded-full border border-white/[0.08] px-2 py-0.5 text-ink-3">
                  {k} <span className="font-mono text-ink-2">{v}</span>
                </span>
              ))}
            </div>
          )}
          {data?.optionLimitsError && <p className="mt-2 text-[12px] text-alert">option_limits.json: {data.optionLimitsError}</p>}

          <div className="mt-3 flex items-center gap-2 text-[11px] text-ink-3">
            <ShieldCheck size={12} />
            Options guard (every 60 s: premium stops, expiry flatten){data?.guard.at ? ` · last ${new Date(data.guard.at * 1000).toLocaleTimeString()} · ${data.guard.flattened ?? 0} flattened · ${data.guard.stopped ?? 0} stopped` : ""}
            {data?.guard.errors?.length ? <span className="text-alert">· {data.guard.errors[0]}</span> : null}
            <button className="pill-glass ml-auto !h-7 text-[11px]" disabled={!!busy} onClick={() => void run("guard", async () => {
              const r = await enginesApi.guard();
              toast({ title: "Options guard", body: r.skipped ?? `${r.flatten.length} flattened · ${r.stops.length} stopped${r.errors.length ? ` · ${r.errors[0]}` : ""}`, tone: r.errors.length ? "warn" : "info" });
            })}>
              Run now
            </button>
          </div>
        </section>
      </div>
      <p className="mt-3 text-[11px] text-ink-3">Engines propose; the Security Detail decides; the desk mode decides what is sent. Options: long calls/puts and debit verticals only — never naked, never held into expiry.</p>
    </Card>
  );
}

function ProposalCard({ p }: { p: OptionsProposal }) {
  const i = p.intent;
  return (
    <div className="mt-3 rounded-[14px] border border-white/[0.08] bg-white/[0.02] p-3 text-[12px]">
      <p className="text-ink-2">
        <span className="font-mono">{p.symbol}</span> · {p.view ?? "no view"} <span className="text-ink-3">({p.viewWhy})</span>
      </p>
      {i ? (
        <>
          <p className="mt-1 font-mono text-[13px]">
            BUY {i.quantity} × {i.legs?.map((l) => `${l.action === "SELL" ? "−" : "+"}${l.right}${l.strike}`).join(" / ")} {p.expiry} ({p.dte} DTE)
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-3">
            limit {i.limit_price} · stop {i.stop_loss} · target {i.take_profit} · max loss {(Number(i.limit_price) * 100 * i.quantity).toFixed(0)} USD
          </p>
        </>
      ) : null}
      <p className={`mt-1 ${p.desk ? (VERDICT_TONE[p.desk.verdict ?? ""] ?? "") : "text-ink-3"}`}>
        {p.result}
        {p.desk?.reasons?.length ? ` — ${p.desk.reasons[0]}` : ""}
      </p>
      {p.notes?.length ? <p className="mt-1 truncate text-[11px] text-ink-3" title={p.notes.join("\n")}>skipped: {p.notes.slice(0, 3).join(" · ")}</p> : null}
    </div>
  );
}
