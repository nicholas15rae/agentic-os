import { create } from "zustand";
import { isTauri, native } from "@/lib/platform";
import type { NodeDef } from "./types";
import type { ArbiterNode, Handoff } from "@/features/arbiter/api";

export type SysPage = 1 | 2 | 3;

const PAGE_KEY = "cc.sysmap.page";
const HUD_KEY = "cc.sysmap.hud";

function read<T>(key: string, ok: (v: string) => boolean, fallback: T, parse: (v: string) => T): T {
  try {
    const v = localStorage.getItem(key);
    return v != null && ok(v) ? parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* private mode: per-session only */
  }
}

export type InspectFocus = "rag" | "memory" | "caps";

/**
 * System Map page + Deep Inspector state, shared by Page 2 (Schematic) and Page 3 (Orbital).
 * The page and the HUD density are per-viewer conveniences (localStorage, guarded).
 */
export interface SysMapStore {
  page: SysPage;
  /** Roster node the Deep Inspector shows (null: closed). */
  inspect: string | null;
  focus: InspectFocus;
  hud: "minimal" | "full";
  setPage: (p: SysPage) => void;
  open: (node: string, focus?: InspectFocus) => void;
  close: () => void;
  setHud: (h: "minimal" | "full") => void;
}

export const useSysMap = create<SysMapStore>((set) => ({
  page: read<SysPage>(PAGE_KEY, (v) => ["1", "2", "3"].includes(v), 1, (v) => Number(v) as SysPage),
  inspect: null,
  focus: "rag",
  hud: read<"minimal" | "full">(HUD_KEY, (v) => v === "minimal" || v === "full", "minimal", (v) => v as "minimal" | "full"),
  setPage: (page) => {
    write(PAGE_KEY, String(page));
    set({ page });
  },
  open: (inspect, focus = "rag") => set({ inspect, focus }),
  close: () => set({ inspect: null }),
  setHud: (hud) => {
    write(HUD_KEY, hud);
    set({ hud });
  },
}));

// ── agent_inspect (arbiter.rs) ───────────────────────────────────────────────

export interface MemEntryPreview {
  id: string;
  at: number;
  lastHit: number;
  hits: number;
  done: boolean;
  tags: string[];
  preview: string;
}

/** A memtier namespace in depth (`memtier::detail`). */
export interface NamespaceDetail {
  namespace: string;
  active: number;
  activeMax: number;
  archived: number;
  activeKb: number;
  done: number;
  hits: number;
  lastWriteAt: number | null;
  lastHitAt: number | null;
  oldestActiveAt: number | null;
  collections: { tag: string; count: number }[];
  recent: MemEntryPreview[];
}

/** Finance: sealed counts only, never contents. */
export interface VaultDetail {
  namespace: "finance";
  sealed: boolean;
  entries: number | null;
  hasLedger: boolean;
  hasKey: boolean;
  idleSecs: number | null;
}

export interface AgentInspect {
  node: NodeDef;
  live: ArbiterNode | null;
  memory: NamespaceDetail | VaultDetail | null;
  lifecycle: { graduateAfterDays: number; dumpKeepDays: number; garbageEveryMinutes: number; lastPurgeAt: number | null; vaultIdleMinutes: number };
  upstream: string[];
  downstream: string[];
  feed: Handoff[];
  holder: string | null;
  away: boolean;
}

export const isVault = (m: AgentInspect["memory"]): m is VaultDetail => !!m && "sealed" in m;

export function inspectAgent(node: string): Promise<AgentInspect | null> {
  if (!isTauri()) return Promise.resolve(null);
  return native<AgentInspect>("agent_inspect", { node });
}
