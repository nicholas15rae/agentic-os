import { useEffect, useRef, useState } from "react";

/**
 * TradingView's free "Advanced Real-Time Chart" widget
 * (https://www.tradingview.com/widget-docs/widgets/charts/advanced-chart/).
 *
 * Why not tv.js: the legacy tv.js loader builds an iframe on
 * s.tradingview.com/widgetembed, which renders white inside WebView2 (Tauri)
 * even though it works in a normal browser. The current embed script builds
 * its iframe on www.tradingview-widget.com, the host TradingView now supports
 * for third-party embedding.
 *
 * Mount model: every effect run builds a brand-new container and the cleanup
 * removes it, so React StrictMode's mount → unmount → mount can never leave
 * two widgets (or a cleared-but-orphaned one) behind.
 */
const EMBED_SRC = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

export interface TvChartProps {
  symbol: string;
  interval: string;
  height?: number;
}

export function tvWidgetConfig(symbol: string, interval: string): Record<string, unknown> {
  return {
    autosize: true,
    symbol,
    interval,
    timezone: "America/Toronto",
    theme: "dark",
    style: "1",
    locale: "en",
    backgroundColor: "rgba(11, 13, 17, 0.15)",
    gridColor: "rgba(255, 255, 255, 0.06)",
    allow_symbol_change: true,
    hide_side_toolbar: false,
    withdateranges: true,
    save_image: false,
    calendar: false,
    support_host: "https://www.tradingview.com",
  };
}

export function TvChart({ symbol, interval, height = 440 }: TvChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    setErr(null);

    const container = document.createElement("div");
    container.className = "tradingview-widget-container";
    container.style.height = "100%";
    container.style.width = "100%";
    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "100%";
    widget.style.width = "100%";
    container.appendChild(widget);

    const script = document.createElement("script");
    script.src = EMBED_SRC;
    script.type = "text/javascript";
    script.async = true;
    // The embed script reads its config from its own text content.
    script.text = JSON.stringify(tvWidgetConfig(symbol, interval));
    script.onerror = () => setErr("embed script blocked or offline");
    container.appendChild(script);

    root.appendChild(container);
    return () => {
      script.onerror = null;
      container.remove();
    };
  }, [symbol, interval]);

  return (
    <div style={{ height }} className="relative w-full overflow-hidden r-12">
      <div ref={host} className="h-full w-full" data-testid="tv-chart-host" />
      {err && <p className="absolute inset-0 grid place-items-center text-sm text-ink-3">TradingView unavailable — {err}</p>}
    </div>
  );
}
