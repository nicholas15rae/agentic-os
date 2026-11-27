import { lazy } from "react";
import { BrainCircuit, HardDriveDownload, ListOrdered, Search } from "lucide-react";
import { registerWidget } from "@/core/widgets/registry";
import { surfaceStore } from "@/core/widgets/layout-store";
import type { WidgetDefinition, WidgetInstance, WidgetProps } from "@/core/widgets/types";
import { isTauri, type Platform } from "@/lib/platform";

/**
 * The Vault page on the shared layout system (AGENTS.md, "Everything Is Customizable"): the search
 * box, its results, offline backups and (desktop) the memory lifecycle are panels.
 */
export const VAULT_SURFACE = "vault";

type Size = { w: number; h: number };

const panel = (id: string, title: string, description: string, icon: WidgetDefinition["icon"], load: () => Promise<React.ComponentType<WidgetProps>>, size: Size, compactOrder: number, platforms?: Platform[], minSize: Size = { w: 3, h: 1 }): WidgetDefinition => ({
  id,
  title,
  description,
  icon,
  defaultSize: size,
  minSize,
  defaultConfig: {},
  surfaces: [VAULT_SURFACE],
  panel: true,
  compactOrder,
  ...(platforms ? { platforms } : {}),
  component: lazy(async () => ({ default: await load() })),
});

const section = () => import("@/sections/VaultSection");

export const VAULT_PANELS: WidgetDefinition[] = [
  panel("va-search", "Vault search", "Ask the local vault in plain language (semantic + keyword), filtered by collection.", Search, async () => (await section()).VaultSearchPanel, { w: 12, h: 2 }, 1, undefined, { w: 4, h: 2 }),
  panel("va-results", "Results", "What the last vault search found; a tap opens its page.", ListOrdered, async () => (await section()).VaultResultsPanel, { w: 7, h: 6 }, 2),
  panel("va-backups", "Offline backups", "Backup now, re-index, the schedule, item / vault / LLM health and the backup list.", HardDriveDownload, async () => (await section()).BackupCard, { w: 5, h: 3 }, 3),
  panel("va-memory", "Memory lifecycle", "Harvests, the memory ledger and its schedule (desktop app).", BrainCircuit, async () => (await section()).VaultMemoryPanel, { w: 5, h: 3 }, 4, ["desktop"]),
];
for (const p of VAULT_PANELS) registerWidget(p);

/** The finished template (what Reset restores): search across the top, results left, backups and memory right. */
export const VAULT_DEFAULT_DESKTOP: WidgetInstance[] = [
  { instanceId: "search", widgetId: "va-search", col: 1, row: 1, w: 12, h: 2, config: {} },
  { instanceId: "results", widgetId: "va-results", col: 1, row: 3, w: 7, h: 6, config: {} },
  { instanceId: "backups", widgetId: "va-backups", col: 8, row: 3, w: 5, h: 3, config: {} },
  { instanceId: "memory", widgetId: "va-memory", col: 8, row: 6, w: 5, h: 3, config: {} },
];
/** Browser / phone: the memory lifecycle is desktop-only, so backups take its rows. */
export const VAULT_DEFAULT_WEB: WidgetInstance[] = [
  { instanceId: "search", widgetId: "va-search", col: 1, row: 1, w: 12, h: 2, config: {} },
  { instanceId: "results", widgetId: "va-results", col: 1, row: 3, w: 7, h: 6, config: {} },
  { instanceId: "backups", widgetId: "va-backups", col: 8, row: 3, w: 5, h: 6, config: {} },
];
export const VAULT_DEFAULT = isTauri() ? VAULT_DEFAULT_DESKTOP : VAULT_DEFAULT_WEB;

export const useVaultLayout = surfaceStore({ surface: VAULT_SURFACE, defaults: VAULT_DEFAULT });
