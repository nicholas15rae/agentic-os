import { lazy } from "react";
import { Inbox, Library, MessagesSquare, PanelTop } from "lucide-react";
import { registerWidget } from "@/core/widgets/registry";
import { surfaceStore } from "@/core/widgets/layout-store";
import type { WidgetDefinition, WidgetInstance, WidgetProps } from "@/core/widgets/types";
import { isTauri, type Platform } from "@/lib/platform";

/**
 * The Agents page on the shared layout system (AGENTS.md, "Everything Is Customizable"): thread
 * tabs, the conversation, the agent's reports and the Skills & MCP library are panels.
 */
export const AGENTS_SURFACE = "agents";

const panel = (id: string, title: string, description: string, icon: WidgetDefinition["icon"], load: () => Promise<React.ComponentType<WidgetProps>>, size: { w: number; h: number }, compactOrder: number, platforms?: Platform[]): WidgetDefinition => ({
  id,
  title,
  description,
  icon,
  defaultSize: size,
  minSize: { w: 3, h: 1 },
  defaultConfig: {},
  surfaces: [AGENTS_SURFACE],
  panel: true,
  compactOrder,
  ...(platforms ? { platforms } : {}),
  component: lazy(async () => ({ default: await load() })),
});

const mod = () => import("@/sections/AgentsSection");

export const AGENTS_PANELS: WidgetDefinition[] = [
  panel("ag-threads", "Threads", "The conversation tabs (frozen agents grouped), routing switches, help desk and Clear.", PanelTop, async () => (await mod()).AgentThreadsBar, { w: 12, h: 2 }, 1),
  { ...panel("ag-chat", "Conversation", "The selected thread: transcript, mic and message box.", MessagesSquare, async () => (await mod()).AgentChat, { w: 8, h: 6 }, 2), compactHeight: "calc(100dvh - 15rem)" },
  panel("ag-reports", "Agent reports", "Reports from the selected agent (every agent's on Auto-route), unread first.", Inbox, async () => {
    const { AgentReports } = await mod();
    return function AgentReportsPanel(p: WidgetProps) {
      return <AgentReports compact={p.display === "compact"} />;
    };
  }, { w: 4, h: 4 }, 3),
  panel("ag-library", "Skills and MCP", "The tools each agent has and the skills library.", Library, async () => (await mod()).AgentLibrary, { w: 4, h: 3 }, 4, ["desktop"]),
];
for (const p of AGENTS_PANELS) registerWidget(p);

// The tab bar wraps to two lines on most screens: two rows, so nothing hides behind a scrollbar.
export const AGENTS_DEFAULT_DESKTOP: WidgetInstance[] = [
  { instanceId: "threads", widgetId: "ag-threads", col: 1, row: 1, w: 12, h: 2, config: {} },
  { instanceId: "chat", widgetId: "ag-chat", col: 1, row: 3, w: 8, h: 6, config: {} },
  { instanceId: "reports", widgetId: "ag-reports", col: 9, row: 3, w: 4, h: 3, config: {} },
  { instanceId: "library", widgetId: "ag-library", col: 9, row: 6, w: 4, h: 3, config: {} },
];
/** Browser / phone: the library is desktop-only. */
export const AGENTS_DEFAULT_WEB: WidgetInstance[] = [
  { instanceId: "threads", widgetId: "ag-threads", col: 1, row: 1, w: 12, h: 2, config: {} },
  { instanceId: "chat", widgetId: "ag-chat", col: 1, row: 3, w: 8, h: 6, config: {} },
  { instanceId: "reports", widgetId: "ag-reports", col: 9, row: 3, w: 4, h: 6, config: {} },
];
export const AGENTS_DEFAULT = isTauri() ? AGENTS_DEFAULT_DESKTOP : AGENTS_DEFAULT_WEB;

export const useAgentsLayout = surfaceStore({ surface: AGENTS_SURFACE, defaults: AGENTS_DEFAULT });
