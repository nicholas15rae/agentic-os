import { lazy, useEffect } from "react";
import { BookUser, Cable, Grid3x3, Inbox, MessageSquare, MessagesSquare, PhoneIncoming, Send } from "lucide-react";
import { registerWidget } from "@/core/widgets/registry";
import { surfaceStore } from "@/core/widgets/layout-store";
import type { WidgetDefinition, WidgetInstance, WidgetProps } from "@/core/widgets/types";
import { isTauri, type Platform } from "@/lib/platform";
import { isDesktopApp } from "@/stores/settings";

/**
 * Comms on the shared layout system (AGENTS.md, "Everything Is Customizable"): the old tabs
 * (Agents, Messages, Calls, Phone book, WhatsApp, Phone bridge) are panels on the same grid as the
 * home page, so they can be moved, resized, hidden, added back, collapsed to an icon or opened in
 * a window, per mode, with Reset to default.
 */
export const COMMS_SURFACE = "comms";

const panel = (id: string, title: string, description: string, icon: WidgetDefinition["icon"], load: () => Promise<React.ComponentType<WidgetProps>>, size: { w: number; h: number }, compactOrder: number, platforms?: Platform[]): WidgetDefinition => ({
  id,
  title,
  description,
  icon,
  defaultSize: size,
  minSize: { w: 3, h: 2 },
  defaultConfig: {},
  surfaces: [COMMS_SURFACE],
  panel: true,
  compactOrder,
  ...(platforms ? { platforms } : {}),
  component: lazy(async () => ({ default: await load() })),
});

const mod = () => import("@/sections/CommsSection");

export const COMMS_PANELS: WidgetDefinition[] = [
  panel("cm-threads", "Conversations", "Texts and WhatsApp threads: search, unread counts; pick one to open it.", MessageSquare, async () => (await mod()).CommsThreads, { w: 4, h: 5 }, 1),
  { ...panel("cm-chat", "Conversation", "The open conversation: messages, reply box, Instant Send, call, add to the phone book.", MessagesSquare, async () => (await mod()).CommsChat, { w: 5, h: 5 }, 2), compactHeight: "calc(100dvh - 15rem)" },
  panel("cm-agents", "Agent reports", "Reports from your agents when a background job finishes, unread first.", Inbox, async () => {
    const [{ CommsAgentReports }, { unreadCount, useAgentInbox }] = await Promise.all([mod(), import("@/features/comms/agent-inbox")]);
    return function AgentReportsPanel({ display, setBadge }: WidgetProps) {
      // The icon's badge: unread reports (the old Agents tab count).
      const unread = useAgentInbox((s) => unreadCount(s.messages));
      useEffect(() => setBadge?.(unread ? String(unread) : null), [unread, setBadge]);
      return <CommsAgentReports compact={display === "compact"} />;
    };
  }, { w: 3, h: 3 }, 3, ["desktop"]),
  panel("cm-dialer", "Dialer", "Keypad and name lookup: call from this device or ask the phone bridge to dial.", Grid3x3, async () => (await mod()).DialPad, { w: 3, h: 3 }, 4),
  panel("cm-calls", "Recent calls", "The synced call log with call-back buttons.", PhoneIncoming, async () => (await mod()).RecentCalls, { w: 3, h: 3 }, 5),
  panel("cm-phonebook", "Phone book", "Your contacts: groups, companies, notes.", BookUser, async () => (await mod()).PhoneBook, { w: 3, h: 3 }, 6),
  // The local WhatsApp MCP bridge runs on the desktop only (the old tab was desktop-only too).
  panel("cm-whatsapp", "WhatsApp", "The local WhatsApp MCP bridge: recent chats, latest messages, send (confirmed).", Send, async () => (await mod()).WhatsAppPanel, { w: 3, h: 3 }, 7, ["desktop"]),
  panel("cm-bridge", "Phone bridge", "How the phone pushes texts and calls to this desktop, and polls for replies.", Cable, async () => (await mod()).BridgeSetup, { w: 3, h: 2 }, 8),
];
for (const p of COMMS_PANELS) registerWidget(p);

/** The finished template (what Reset restores): conversations on top, calls and contacts below. */
export const COMMS_DEFAULT_DESKTOP: WidgetInstance[] = [
  { instanceId: "threads", widgetId: "cm-threads", col: 1, row: 1, w: 4, h: 5, config: {} },
  { instanceId: "chat", widgetId: "cm-chat", col: 5, row: 1, w: 5, h: 5, config: {} },
  { instanceId: "agents", widgetId: "cm-agents", col: 10, row: 1, w: 3, h: 3, config: {} },
  { instanceId: "bridge", widgetId: "cm-bridge", col: 10, row: 4, w: 3, h: 2, config: {} },
  { instanceId: "dialer", widgetId: "cm-dialer", col: 1, row: 6, w: 3, h: 3, config: {} },
  { instanceId: "calls", widgetId: "cm-calls", col: 4, row: 6, w: 3, h: 3, config: {} },
  { instanceId: "phonebook", widgetId: "cm-phonebook", col: 7, row: 6, w: 3, h: 3, config: {} },
  { instanceId: "whatsapp", widgetId: "cm-whatsapp", col: 10, row: 6, w: 3, h: 3, config: {} },
];
/** Browser / phone: no agent reports or WhatsApp (desktop-only), so the conversation is wider. */
export const COMMS_DEFAULT_WEB: WidgetInstance[] = [
  { instanceId: "threads", widgetId: "cm-threads", col: 1, row: 1, w: 4, h: 5, config: {} },
  { instanceId: "chat", widgetId: "cm-chat", col: 5, row: 1, w: 8, h: 5, config: {} },
  { instanceId: "dialer", widgetId: "cm-dialer", col: 1, row: 6, w: 3, h: 3, config: {} },
  { instanceId: "calls", widgetId: "cm-calls", col: 4, row: 6, w: 3, h: 3, config: {} },
  { instanceId: "phonebook", widgetId: "cm-phonebook", col: 7, row: 6, w: 3, h: 3, config: {} },
  { instanceId: "bridge", widgetId: "cm-bridge", col: 10, row: 6, w: 3, h: 3, config: {} },
];
/** The Android app: WhatsApp yes (the old page showed it), agent reports no (desktop-only). */
export const COMMS_DEFAULT_ANDROID: WidgetInstance[] = COMMS_DEFAULT_DESKTOP.filter((i) => i.widgetId !== "cm-agents").map((i) => (i.widgetId === "cm-bridge" ? { ...i, row: 1, h: 5 } : i));
export const COMMS_DEFAULT = isDesktopApp() ? COMMS_DEFAULT_DESKTOP : isTauri() ? COMMS_DEFAULT_ANDROID : COMMS_DEFAULT_WEB;

export const useCommsLayout = surfaceStore({ surface: COMMS_SURFACE, defaults: COMMS_DEFAULT });
