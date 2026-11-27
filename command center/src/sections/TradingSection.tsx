import { TvChart } from "@/features/trading/TvChart";
import { cmd, isTauri } from "@/lib/platform";
import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Card, Chip, Input, Select, Stat } from "@/components/ui";
import { cc, type MarketData } from "@/lib/cc-api";
import { useSettings, type SettingsState } from "@/stores/settings";
import { supplyDemandZones, toTradingView, volumeProfile } from "@/features/trading/analysis";
import { CompanionChart } from "@/features/trading/CompanionChart";
import { IbkrBarsChart } from "@/features/trading/IbkrBarsChart";
import { ReadOnlyBanner } from "@/features/security/ReadOnlyBanner";
import { LayoutSurface } from "@/core/widgets/LayoutSurface";
import { useTradingLayout } from "./trading/panels";
import { FillBox } from "@/components/FillBox";

const INTERVALS: [string, string, string][] = [
  // [yahoo, label, tradingview]
  ["1m", "1m", "1"],
  ["5m", "5m", "5"],
  ["15m", "15m", "15"],
  ["30m", "30m", "30"],
  ["60m", "1h", "60"],
  ["1d", "1D", "D"],
];
const DEFAULT_WATCHLIST = ["SPY", "QQQ", "IWM", "GLD", "SLV", "USO", "UNG", "DBC"];
const RANGES = ["1d", "5d", "1mo", "3mo", "6mo", "1y"];

type TradingSettings = SettingsState["trading"];

/** Patch the trading settings, always merged onto the latest values (panels share them). */
const upTrading = (patch: Partial<TradingSettings>) => {
  const st = useSettings.getState();
  st.set({ trading: { ...st.trading, ...patch } });
};
const pickSymbol = (s: string) => upTrading({ symbol: s, tvSymbol: toTradingView(s) });

/**
 * Day Trading on the shared layout system (AGENTS.md, "Everything Is Customizable"). TradingView
 * widgets + news, the IBKR paper-account HUD (read-only telemetry from trading/ibkr_bridge.py via
 * /api/trading/*), a companion chart fed by candles from the local gateway with S/D zones and POC,
 * and the execution desk: kill switch, ADVISORY / SEMI_AUTO / FULL_AUTO and trade cards — every
 * OrderIntent passes the deterministic Security Detail first. Each block is a panel (move, resize,
 * hide, add back, per mode, Reset); the desk is a locked safety panel that can never be hidden.
 */
export function TradingSection() {
  return <LayoutSurface store={useTradingLayout} label="Trading" />;
}

/** The Read-Only banner, ticker, TradingView symbol, interval and range. */
export function TradingToolbar() {
  const symbol = useSettings((s) => s.trading.symbol);
  const tvSymbol = useSettings((s) => s.trading.tvSymbol);
  const interval = useSettings((s) => s.trading.interval);
  const range = useSettings((s) => s.trading.range);
  const [symbolInput, setSymbolInput] = useState(symbol);
  // A watchlist pick (its own panel) shows up in the ticker box, as it did on the old page.
  useEffect(() => setSymbolInput(symbol), [symbol]);
  const [tvInput, setTvInput] = useState(tvSymbol);
  useEffect(() => setTvInput(tvSymbol), [tvSymbol]);
  // Commit the TradingView override on Enter / blur only — every keystroke would rebuild the widget.
  const commitTv = () => {
    const v = tvInput.trim().toUpperCase();
    if (v && v !== tvSymbol) upTrading({ tvSymbol: v });
    else setTvInput(tvSymbol);
  };
  return (
    <div className="space-y-2">
      {/* Read-Only by default: positions, balances and telemetry are safe to view; orders, mode and engine changes need a step-up PIN. */}
      <div className="flex justify-end">
        <ReadOnlyBanner module="trading" />
      </div>
      <div className="glass flex flex-wrap items-center gap-2 r-18 p-2.5">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const s = symbolInput.trim().toUpperCase();
            if (s) {
              setSymbolInput(s);
              pickSymbol(s);
            }
          }}
        >
          <Input value={symbolInput} onChange={(e) => setSymbolInput(e.target.value)} className="!h-9 !w-36 !py-1 font-mono fs-13 uppercase" aria-label="Ticker" placeholder="SPY, ES=F, BTC-USD" />
          <button className="pill-primary !h-9 text-xs">Load</button>
        </form>
        <Input
          value={tvInput}
          onChange={(e) => setTvInput(e.target.value.toUpperCase())}
          onBlur={commitTv}
          onKeyDown={(e) => e.key === "Enter" && commitTv()}
          className="!h-9 !w-40 !py-1 font-mono fs-12"
          aria-label="TradingView symbol"
          title="TradingView symbol (auto-mapped; override if needed)"
        />
        <div className="flex gap-1">
          {INTERVALS.map(([v, label]) => (
            <Chip key={v} active={interval === v} onClick={() => upTrading({ interval: v, range: v === "1m" ? "1d" : v === "1d" ? "6mo" : range === "1d" && v !== "1m" ? "5d" : range })}>
              {label}
            </Chip>
          ))}
        </div>
        <Select value={range} onChange={(e) => upTrading({ range: e.target.value })} className="!h-9 !w-auto !py-1 fs-13" aria-label="Range">
          {RANGES.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </Select>
        <span className="ml-auto fs-11 text-ink-3">IBKR paper only · every order passes the Security Detail.</span>
      </div>
    </div>
  );
}

/** Quick-switch tickers. */
export function TradingWatchlist() {
  const symbol = useSettings((s) => s.trading.symbol);
  const watchlist = useSettings((s) => s.trading.watchlist) ?? DEFAULT_WATCHLIST;
  return (
    <div className="glass flex flex-wrap items-center gap-1.5 r-18 p-2.5" aria-label="Watchlist">
      {watchlist.map((s) => (
        <Chip key={s} active={symbol === s} onClick={() => pickSymbol(s)}>
          {s}
        </Chip>
      ))}
    </div>
  );
}

/** The top chart (TradingView or IBKR bars); it reads only the fields the chart uses, so other changes never rebuild it. */
export function TradingChart() {
  const symbol = useSettings((s) => s.trading.symbol);
  const tvSymbol = useSettings((s) => s.trading.tvSymbol);
  const interval = useSettings((s) => s.trading.interval);
  const range = useSettings((s) => s.trading.range);
  const chartSource = useSettings((s) => s.trading.chartSource) ?? "tradingview";
  const tvInterval = INTERVALS.find((i) => i[0] === interval)?.[2] ?? "5";
  return (
    <Card
      title={chartSource === "tradingview" ? `TradingView · ${tvSymbol}` : `IBKR · ${symbol}`}
      className="!p-3"
      fill
      action={
        <div className="flex gap-1">
          <Chip active={chartSource === "tradingview"} onClick={() => upTrading({ chartSource: "tradingview" })}>
            TradingView
          </Chip>
          <Chip active={chartSource === "ibkr"} onClick={() => upTrading({ chartSource: "ibkr" })}>
            IBKR bars
          </Chip>
        </div>
      }
    >
      {/* Fills its panel (the panel's height, never below 240 px), so nothing is cut off. */}
      <FillBox>{(h) => (chartSource === "tradingview" ? <TvChart symbol={tvSymbol} interval={tvInterval} height={h} /> : <IbkrBarsChart symbol={symbol} interval={interval} range={range} height={h} />)}</FillBox>
    </Card>
  );
}

/** TradingView's news timeline for the chart symbol (the iframe reloads only when that symbol changes). */
export function TradingNews() {
  const tvSymbol = useSettings((s) => s.trading.tvSymbol);
  const newsSrc = `https://www.tradingview-widget.com/embed-widget/timeline/?locale=en#${encodeURIComponent(
    JSON.stringify({ feedMode: "symbol", symbol: tvSymbol, colorTheme: "dark", isTransparent: true, displayMode: "regular", width: "100%", height: "100%" }),
  )}`;
  return (
    <Card title="Market news" className="!p-3" fill>
      <FillBox>{(h) => <iframe key={newsSrc} src={newsSrc} title="Market news" style={{ height: h }} className="w-full r-12 border-0" loading="lazy" />}</FillBox>
    </Card>
  );
}

/** Supply / demand zones and the volume-profile POC on gateway candles, live-refreshed. */
export function TradingZones() {
  const t = useSettings((s) => s.trading);
  const [data, setData] = useState<MarketData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [bins, setBins] = useState(48);

  const load = async () => {
    setLoading(true);
    try {
      // Desktop fetches directly (works with the gateway down); the phone uses the gateway.
      setData(isTauri() ? await cmd("market_candles", { symbol: t.symbol, interval: t.interval, range: t.range }).catch(() => cc.candles(t.symbol, t.interval, t.range)) : await cc.candles(t.symbol, t.interval, t.range));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // "Live": refresh on a cadence matched to the bar size; paused while hidden.
  useEffect(() => {
    void load();
    const ms = t.interval === "1d" ? 300_000 : t.interval === "1m" ? 15_000 : 30_000;
    const id = setInterval(() => !document.hidden && void load(), ms);
    return () => clearInterval(id);
  }, [t.symbol, t.interval, t.range]); // eslint-disable-line react-hooks/exhaustive-deps

  const candles = data?.candles ?? [];
  const profile = useMemo(() => volumeProfile(candles, bins), [candles, bins]);
  const zones = useMemo(() => supplyDemandZones(candles), [candles]);
  const last = candles.at(-1);

  return (
    <Card
      fill
      title={`Supply / demand & POC · ${data?.symbol ?? t.symbol} · ${t.interval}`}
      hint={data ? `${candles.length} bars · ${data.source} · updated ${new Date(data.fetchedAt * 1000).toLocaleTimeString()}` : undefined}
      action={
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip active={t.showPoc} onClick={() => upTrading({ showPoc: !t.showPoc })}>
            POC
          </Chip>
          <Chip active={t.showValueArea} onClick={() => upTrading({ showValueArea: !t.showValueArea })}>
            Value area
          </Chip>
          <Chip active={t.showZones} onClick={() => upTrading({ showZones: !t.showZones })} tone="teal">
            Zones
          </Chip>
          <Select value={bins} onChange={(e) => setBins(Number(e.target.value))} className="!h-8 !w-auto !py-0 fs-12" aria-label="Profile resolution">
            {[24, 48, 72, 96].map((b) => (
              <option key={b} value={b}>
                {b} bins
              </option>
            ))}
          </Select>
          <button onClick={() => void load()} aria-label="Refresh" className="pill-glass !h-8 !w-8 !p-0">
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
        </div>
      }
    >
      {error && <p className="mb-2 text-sm text-alert">{error}</p>}
      {candles.length ? (
        <FillBox min={260}>{(h) => <CompanionChart candles={candles} profile={profile} zones={zones} showPoc={t.showPoc} showZones={t.showZones} showValueArea={t.showValueArea} height={h} />}</FillBox>
      ) : (
        <div className="grid h-[300px] place-items-center text-sm text-ink-3">{loading ? "Loading candles…" : "No data — check the ticker (Yahoo format: SPY, ES=F, BTC-USD, SHOP.TO)."}</div>
      )}
      {profile && last && (
        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">
          <Stat label="Last" value={last.c.toFixed(2)} tone={last.c >= last.o ? "teal" : "alert"} />
          <Stat label="POC" value={profile.poc.toFixed(2)} sub={`${(((last.c - profile.poc) / profile.poc) * 100).toFixed(2)}% from price`} tone="amber" />
          <Stat label="Value area" value={`${profile.val.toFixed(2)} – ${profile.vah.toFixed(2)}`} sub={last.c > profile.vah ? "price above VA" : last.c < profile.val ? "price below VA" : "price inside VA"} />
          <Stat label="Demand zones" value={zones.filter((z) => z.kind === "demand").length} sub={nearest(zones, "demand", last.c)} tone="teal" />
          <Stat label="Supply zones" value={zones.filter((z) => z.kind === "supply").length} sub={nearest(zones, "supply", last.c)} tone="alert" />
        </div>
      )}
      <p className="mt-3 fs-11 text-ink-3">
        Zones: a tight base followed by a ≥1.5×ATR move; dashed = already tested, removed once price closes through. Volume is spread across each bar's range. Educational tool, not trading advice.
      </p>
    </Card>
  );
}

function nearest(zones: { kind: string; low: number; high: number }[], kind: string, price: number) {
  const zs = zones.filter((z) => z.kind === kind);
  if (!zs.length) return "none active";
  const z = zs.reduce((a, b) => (Math.abs((b.low + b.high) / 2 - price) < Math.abs((a.low + a.high) / 2 - price) ? b : a));
  return `nearest ${z.low.toFixed(2)}–${z.high.toFixed(2)}`;
}
