import { Card, Stat } from "@/components/ui";
import { usePoll } from "@/lib/use-poll";
import { hudLevel, marketTone, money, pnlTone, tradingApi, type HudLevel, type IbkrStatus } from "@/features/trading/ibkr";

const MARKET_CHIP = {
  open: "border-teal/40 text-teal-soft",
  early: "border-amber/50 bg-amber/10 text-amber-light",
  closed: "border-white/20 text-ink-2",
} as const;

const BADGE: Record<HudLevel, string> = {
  connected: "border-teal/50 bg-teal/15 text-teal-soft",
  reconnecting: "border-amber/50 bg-amber/15 text-amber-light",
  locked: "border-alert/60 bg-alert/15 text-alert",
  disconnected: "border-white/15 bg-white/[0.04] text-ink-3",
};

/** Live IBKR paper-account HUD. Read-only: Phase 1 has no order path. */
export function IbkrHud() {
  const { data, error } = usePoll<IbkrStatus>(tradingApi.status, 2_000);
  const { level, label } = hudLevel(error ? null : data);
  const s = error ? null : data;
  const acct = s?.account;
  const cur = acct?.currency ?? null;

  return (
    <Card
      title="IBKR · paper account"
      action={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {s?.market && (
            <span className={`rounded-full border px-2 py-0.5 fs-10 ${MARKET_CHIP[marketTone(s.market)]}`} title={`US market (NYSE calendar) · next open ${s.market.nextOpenNy} ET${s.market.known ? "" : " · holidays unknown for this year"}`}>
              {s.market.label}
            </span>
          )}
          <span className="rounded-full border border-teal/40 px-2 py-0.5 font-mono fs-10 tracking-wider text-teal-soft" title="Only the paper socket (7497) can be dialled">
            {s?.mode ?? "PAPER"}
            {s?.port ? ` · ${s.port}` : ""}
          </span>
          {s?.readOnly !== false && (
            <span className="rounded-full border border-white/20 px-2 py-0.5 font-mono fs-10 tracking-wider text-ink-2" title="The bridge connects read-only; no orders can be sent">
              READ-ONLY
            </span>
          )}
          <span role="status" aria-label={`IBKR ${label}`} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 fs-11 font-medium ${BADGE[level]}`}>
            <span className={`h-1.5 w-1.5 rounded-full bg-current ${level === "reconnecting" ? "animate-pulse" : ""}`} />
            {label}
          </span>
        </div>
      }
    >
      {s?.alert && (
        <div role="alert" className="mb-3 r-12 border border-alert/60 bg-alert/15 px-3 py-2 fs-12 text-alert">
          <p className="font-semibold">{s.alert.message}</p>
          <p className="mt-0.5 text-ink-2">Down since {s.alert.sinceNy}: {s.alert.reason}</p>
        </div>
      )}
      {(error || (s && level !== "connected")) && !s?.alert && (
        <p className={`mb-3 fs-12 ${level === "locked" ? "text-alert" : "text-ink-3"}`}>
          {error
            ? `Gateway: ${error}`
            : s?.downReason || [...(s?.reasons ?? []), s?.lastError].filter(Boolean).join(" · ") || "Waiting for TWS on 127.0.0.1:7497…"}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Stat label="Net liquidation" value={money(acct?.netLiquidation, null)} sub={acct ? `${acct.account} · ${cur}` : undefined} />
        <Stat label="Buying power" value={money(acct?.buyingPower, null)} sub={acct ? `available ${money(acct.availableFunds, null)}` : undefined} />
        <Stat label="Daily P&L" value={money(s?.pnl.daily, null)} tone={pnlTone(s?.pnl.daily)} />
        <Stat label="Unrealized" value={money(s?.pnl.unrealized, null)} tone={pnlTone(s?.pnl.unrealized)} />
        <Stat label="Realized" value={money(s?.pnl.realized, null)} tone={pnlTone(s?.pnl.realized)} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Table
          title={`Open positions (${s?.positions.length ?? 0})`}
          empty="No open positions"
          head={["Symbol", "Qty", "Avg", "Last", "Unrl P&L"]}
          rows={(s?.positions ?? []).map((p) => ({
            key: String(p.conId),
            cells: [
              <span key="s" title={p.secType}>{p.symbol}</span>,
              p.position ?? "—",
              money(p.avgCost),
              money(p.marketPrice),
              <span key="u" className={pnlTone(p.unrealizedPnl) === "alert" ? "text-alert" : pnlTone(p.unrealizedPnl) === "teal" ? "text-teal-soft" : ""}>{money(p.unrealizedPnl)}</span>,
            ],
          }))}
        />
        <Table
          title={`Open orders (${s?.openOrders.length ?? 0})`}
          empty="No working orders"
          head={["Symbol", "Side", "Qty", "Type", "Status"]}
          rows={(s?.openOrders ?? []).map((o) => ({
            key: String(o.permId || o.orderId),
            cells: [
              o.symbol,
              <span key="a" className={o.action === "BUY" ? "text-teal-soft" : "text-alert"}>{o.action}</span>,
              `${o.filled ?? 0}/${o.quantity ?? "—"}`,
              `${o.orderType}${o.limitPrice ? ` ${o.limitPrice}` : ""}${o.stopPrice ? ` stp ${o.stopPrice}` : ""}`,
              o.status,
            ],
          }))}
        />
      </div>
    </Card>
  );
}

function Table({ title, head, rows, empty }: { title: string; head: string[]; rows: { key: string; cells: React.ReactNode[] }[]; empty: string }) {
  return (
    <div className="min-w-0">
      <p className="label-caps mb-1.5 text-ink-3">{title}</p>
      {rows.length ? (
        <div className="overflow-x-auto r-12 border border-white/[0.06]">
          <table className="w-full fs-12">
            <thead>
              <tr className="text-left text-ink-3">
                {head.map((h) => (
                  <th key={h} className="px-2.5 py-1.5 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono tabular">
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-white/[0.04]">
                  {r.cells.map((c, i) => (
                    <td key={i} className="whitespace-nowrap px-2.5 py-1.5">{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="r-12 border border-dashed border-white/[0.08] px-3 py-4 text-center fs-12 text-ink-3">{empty}</p>
      )}
    </div>
  );
}
