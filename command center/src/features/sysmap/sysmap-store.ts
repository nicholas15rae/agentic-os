import { create } from "zustand";
import { isTauri, native } from "@/lib/platform";
import type { NodeDef } from "./types";
import { PHONE_LITE } from "@/lib/phone-lite";
import type { ArbiterNode, Handoff } from "@/features/arbiter/api";

/** Page ids are stable (1 Blueprint · 2 Schematic · 3 Orbital); the TAB ORDER lives in `PAGES`. */
export type SysPage = 1 | 2 | 3;

/** The System Map always opens on the Schematic Flowchart (the operational view). */
export const DEFAULT_PAGE: SysPage = 2;

/** Tab order (operational view first). Ids stay stable; the pill number is the tab POSITION. */
const ALL_PAGES: readonly { id: SysPage; label: string; hint: string }[] = [
  { id: 2, label: "Schematic Flowchart", hint: "Architectural wiring, live diagnostics & orchestration mode" },
  { id: 1, label: "Gabagool Blueprint", hint: "Agent blueprint: hardware & telemetry deck" },
  { id: 3, label: "Orbital Ecosystem", hint: "3D planetary star map" },
];

/** The phone app has no Orbital Ecosystem: a full 3D WebGL scene it doesn't need (and its chunk,
 * the only one with three.js, is then never downloaded there). */
export const PAGES: readonly { id: SysPage; label: string; hint: string }[] = PHONE_LITE ? ALL_PAGES.filter((p) => p.id !== 3) : ALL_PAGES;

/** A page this build offers (the phone: never 3). */
export const allowedPage = (p: SysPage): SysPage => (PAGES.some((x) => x.id === p) ? p : DEFAULT_PAGE);

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
 * Every load starts on the Schematic Flowchart (`DEFAULT_PAGE`); the HUD density is a per-viewer
 * convenience (localStorage, guarded).
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
  page: DEFAULT_PAGE,
  inspect: null,
  focus: "rag",
  hud: read<"minimal" | "full">(HUD_KEY, (v) => v === "minimal" || v === "full", "minimal", (v) => v as "minimal" | "full"),
  setPage: (page) => set({ page: allowedPage(page) }),
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
