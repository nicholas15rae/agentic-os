import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { CompanionChart } from "@/features/trading/CompanionChart";
import { supplyDemandZones, volumeProfile } from "@/features/trading/analysis";
import { barsRefreshMs, tradingApi, type IbkrBars } from "@/features/trading/ibkr";

/**
 * The Trading view's "IBKR bars" chart: historical bars from the paper TWS session
 * (bridge → /api/trading/bars), drawn on the same canvas as the Yahoo companion chart.
 * Polls on a cadence that respects IBKR's historical-data pacing; paused while hidden.
 */
export function IbkrBarsChart({ symbol, interval, range, height = 440 }: { symbol: string; interval: string; range: string; height?: number }) {
  const [data, setData] = useState<IbkrBars | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    const load = async () => {
      setLoading(true);
      try {
        const r = await tradingApi.bars(symbol, interval, range);
        if (!alive) return;
        setData(r);
        setError(r.ok ? null : r.error ?? "IBKR returned no bars");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // The gateway only learns /api/trading/bars when it restarts (trading_api.py is imported once).
        if (alive) setError(msg.startsWith("404") ? "the running gateway predates the IBKR bars route; restart it to load it" : msg);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const id = setInterval(() => !document.hidden && void load(), barsRefreshMs(interval));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [symbol, interval, range]);

  const candles = data?.ok ? data.candles : [];
  const profile = useMemo(() => volumeProfile(candles, 48), [candles]);
  const zones = useMemo(() => supplyDemandZones(candles), [candles]);
  const statusH = 22;

  return (
    <div style={{ height }} className="flex flex-col" data-testid="ibkr-bars-chart">
      <p className="flex h-[22px] items-center gap-1.5 truncate px-1 text-[11px] text-ink-3" style={{ height: statusH }}>
        {loading && <Loader2 size={11} className="animate-spin" />}
        {data?.ok
          ? `${candles.length} bars · ${data.barSize ?? interval} over ${data.duration ?? range}${data.currency && data.currency !== "USD" ? ` · ${data.currency}` : ""} · IBKR paper (TWS) · ${new Date((data.fetchedAt ?? Date.now() / 1000) * 1000).toLocaleTimeString()}`
          : loading
            ? "Requesting bars from TWS…"
            : null}
      </p>
      {candles.length ? (
        <CompanionChart candles={candles} profile={profile} zones={zones} showPoc showZones={false} showValueArea={false} height={height - statusH} />
      ) : (
        <div className="grid flex-1 place-items-center px-6 text-center text-sm text-ink-3" role="status">
          {error ? `IBKR bars unavailable: ${error}` : loading ? "Loading IBKR bars…" : `No IBKR bars for ${symbol}.`}
        </div>
      )}
    </div>
  );
}
