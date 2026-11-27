import { lazy } from "react";
import { Bot, CandlestickChart, Cpu, HeartPulse, Layers, ListFilter, Newspaper, OctagonX, Radar, SlidersHorizontal, Wallet, Zap } from "lucide-react";
import { registerWidget } from "@/core/widgets/registry";
import { surfaceStore } from "@/core/widgets/layout-store";
import type { WidgetDefinition, WidgetInstance, WidgetProps } from "@/core/widgets/types";

/**
 * Trading on the shared layout system (AGENTS.md, "Everything Is Customizable"): every block of
 * the page is a panel on the same 12x8 grid as the home page (move, resize, hide, add back, icon,
 * window, per mode, Reset to default). The execution desk holds the trading kill switch / E-stop,
 * so it is `locked`: it can move and resize but is never hidden, removed, made an icon, moved to
 * another page or made click-through, and it is in the default. Ctrl+Shift+X stays App-level.
 */
export const TRADING_SURFACE = "trading";

type Body = React.ComponentType<WidgetProps>;

const panel = (id: string, title: string, description: string, icon: WidgetDefinition["icon"], load: () => Promise<Body>, size: { w: number; h: number }, compactOrder: number, extra: Partial<WidgetDefinition> = {}): WidgetDefinition => ({
  id,
  title,
  description,
  icon,
  defaultSize: size,
  minSize: { w: 2, h: 1 },
  defaultConfig: {},
  surfaces: [TRADING_SURFACE],
  panel: true,
  compactOrder,
  ...extra,
  component: lazy(async () => ({ default: await load() })),
});

const page = () => import("@/sections/TradingSection");

export const TRADING_PANELS: WidgetDefinition[] = [
  panel("tr-toolbar", "Ticker and timeframe", "Read-Only banner, ticker, TradingView symbol, interval and range.", SlidersHorizontal, async () => (await page()).TradingToolbar, { w: 6, h: 1 }, 1),
  panel("tr-health", "Trading health", "The live bridge state and a read-only health check (synthetic intent, kill-switch dry run, scan with submit off).", HeartPulse, async () => (await import("@/features/trading/HealthCard")).HealthCard, { w: 3, h: 1 }, 2),
  panel("tr-watchlist", "Watchlist", "Quick-switch tickers.", ListFilter, async () => (await page()).TradingWatchlist, { w: 3, h: 1 }, 3),
  panel("tr-chart", "Chart", "TradingView chart, or IBKR bars.", CandlestickChart, async () => (await page()).TradingChart, { w: 8, h: 3 }, 4, { minSize: { w: 3, h: 2 } }),
  panel("tr-news", "Market news", "TradingView's news timeline for the chart symbol.", Newspaper, async () => (await page()).TradingNews, { w: 4, h: 3 }, 5, { minSize: { w: 2, h: 2 } }),
  panel("tr-hud", "IBKR account", "The IBKR paper-account HUD: balances, positions, orders (read-only telemetry).", Wallet, async () => (await import("@/features/trading/IbkrHud")).IbkrHud, { w: 4, h: 2 }, 6),
  panel(
    "tr-desk",
    "Execution desk",
    "Kill switch / E-stop, ADVISORY / SEMI_AUTO / FULL_AUTO and trade cards. A safety control: it can move and resize, never hide.",
    OctagonX,
    async () => (await import("@/features/trading/TradingDesk")).TradingDesk,
    { w: 4, h: 4 },
    7,
    { locked: true, minSize: { w: 3, h: 2 } },
  ),
  panel("tr-engine-r", "Engine R", "Engine R rules: the daily scan, evaluate and the 70/30 report.", Zap, async () => {
    const { EngineRPanel } = await import("@/features/trading/EngineRPanel");
    return function EngineRBody() {
      return <EngineRPanel />;
    };
  }, { w: 2, h: 2 }, 8),
  panel("tr-engines", "Engines", "Engine A (ETFs and commodities) and Engine B (defined-risk options): scan and propose.", Cpu, async () => (await import("@/features/trading/EnginesPanel")).EnginesPanel, { w: 2, h: 2 }, 9),
  panel("tr-agent", "Trading agent", "The retired local-model trading agent: run and decision history.", Bot, async () => {
    const { AgentPanel } = await import("@/features/trading/AgentPanel");
    return function AgentBody() {
      return <AgentPanel />;
    };
  }, { w: 2, h: 2 }, 10),
  panel("tr-intel", "Intel", "Discord hypotheses, their track record and the trade journal.", Radar, async () => (await import("@/features/trading/IntelPanel")).IntelPanel, { w: 2, h: 2 }, 11),
  panel("tr-zones", "Supply / demand & POC", "Companion chart on gateway candles: supply / demand zones, POC and value area.", Layers, async () => (await page()).TradingZones, { w: 4, h: 2 }, 12, { minSize: { w: 3, h: 2 } }),
];
for (const p of TRADING_PANELS) registerWidget(p);

/**
 * The finished template (what Reset restores), desktop and browser alike (no block is
 * desktop-only): controls across the top, the chart with the locked execution desk beside it, and
 * the rest as app icons on the bottom row that open in properly sized windows.
 */
/** A panel that starts as an app icon on row 8 (a tap opens it in a window at `full` size). */
const icon = (instanceId: string, widgetId: string, col: number, full: { w: number; h: number }): WidgetInstance => ({ instanceId, widgetId, col, row: 8, w: 1, h: 1, config: {}, display: "icon", fullSize: full });

export const TRADING_DEFAULT: WidgetInstance[] = [
  // Two rows for the controls: the toolbar wraps (banner + ticker + interval chips + range).
  { instanceId: "toolbar", widgetId: "tr-toolbar", col: 1, row: 1, w: 6, h: 2, config: {} },
  { instanceId: "health", widgetId: "tr-health", col: 7, row: 1, w: 3, h: 2, config: {} },
  { instanceId: "watchlist", widgetId: "tr-watchlist", col: 10, row: 1, w: 3, h: 2, config: {} },
  { instanceId: "chart", widgetId: "tr-chart", col: 1, row: 3, w: 8, h: 5, config: {} },
  // The execution desk (kill switch / E-stop) is locked and always on the page.
  { instanceId: "desk", widgetId: "tr-desk", col: 9, row: 3, w: 4, h: 6, config: {} },
  icon("news", "tr-news", 1, { w: 5, h: 5 }),
  icon("zones", "tr-zones", 2, { w: 6, h: 5 }),
  icon("hud", "tr-hud", 3, { w: 6, h: 4 }),
  icon("engine-r", "tr-engine-r", 4, { w: 6, h: 5 }),
  icon("engines", "tr-engines", 5, { w: 6, h: 5 }),
  icon("agent", "tr-agent", 6, { w: 6, h: 5 }),
  icon("intel", "tr-intel", 7, { w: 6, h: 5 }),
];

export const useTradingLayout = surfaceStore({ surface: TRADING_SURFACE, defaults: TRADING_DEFAULT });
