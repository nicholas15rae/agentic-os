// Contract: features/maps/contract.ts (DRAFT). Pure tab rules for the Maps widget.
import type { MapTab, TabsFit } from "@/features/maps/contract";

export const MAP_TABS: readonly MapTab[] = ["map", "upcoming", "saved"];

/** The saved tab if valid; else Upcoming on the phone (list first, no GPU map until asked), Map on the PC. */
export function resolveTab(saved: unknown, android: boolean): MapTab {
  return typeof saved === "string" && (MAP_TABS as readonly string[]).includes(saved) ? (saved as MapTab) : android ? "upcoming" : "map";
}

/** Icon-only tabs below 4 columns wide; full labels otherwise. */
export function tabsFit(size: { w: number; h: number } | undefined): TabsFit {
  return (size?.w ?? 4) < 4 ? "icons" : "full";
}

/** Rows drop their second line (the address) when 3 columns wide or 2 rows tall or less. */
export function isCompact(size: { w: number; h: number } | undefined): boolean {
  return (size?.h ?? 3) <= 2 || (size?.w ?? 4) <= 3;
}
