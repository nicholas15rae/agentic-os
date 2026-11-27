/**
 * The MASTER switchboard (os.json `switchboard`, Rust `OsConfig.switchboard`): agents and tool
 * servers frozen in EVERY mode. A frozen entry keeps all its settings (routing triggers, workspace,
 * `enabled`, grants); it just never runs (agents) or is never offered / called (tools) until it is
 * thawed. Tony and `ALWAYS_LIVE_TOOLS` can't be frozen. Per-mode overlays live on the modes
 * (`TonyMode.switchboard`); see `features/modes/modes.ts` for the live rule.
 *
 * Pure (types + helpers, no store): imported by the os store, the modes store and Settings.
 */
import type { SwitchboardFreeze } from "@/features/modes/modes";

export interface OsSwitchboard {
  /** 1 once the one-time tool-ownership migration ran (Rust never runs it twice). */
  version: number;
  frozenAgents: string[];
  frozenTools: string[];
}

declare module "@/lib/platform" {
  interface OsConfig {
    /** Optional: an older desktop (or the phone's mirror of one) doesn't send it. */
    switchboard?: OsSwitchboard;
  }
}

/** What Rust seeds a fresh os.json with (os_core.rs `DEFAULT_FROZEN_AGENTS`): the Booking Desk and
 * the Librarian (it runs only as its scheduled script) frozen everywhere. */
/** Rust `default_frozen_agents`: Booking and the Librarian (script only). */
export const DEFAULT_OS_SWITCHBOARD: OsSwitchboard = { version: 1, frozenAgents: ["booking", "librarian"], frozenTools: [] };

/** No switchboard in the config (an older desktop): nothing is frozen, which is what it enforces. */
const NONE: OsSwitchboard = { version: 0, frozenAgents: [], frozenTools: [] };

/** The config's master switchboard, normalised (arrays always present). */
export function osSwitchboard(cfg: { switchboard?: Partial<OsSwitchboard> | null } | null | undefined): OsSwitchboard {
  const s = cfg?.switchboard;
  if (!s) return NONE;
  return {
    version: typeof s.version === "number" ? s.version : 0,
    frozenAgents: Array.isArray(s.frozenAgents) ? s.frozenAgents.filter((x): x is string => typeof x === "string") : [],
    frozenTools: Array.isArray(s.frozenTools) ? s.frozenTools.filter((x): x is string => typeof x === "string") : [],
  };
}

/** The freeze sets the live rule reads. */
export const freezeOf = (s: OsSwitchboard): SwitchboardFreeze => ({ frozenAgents: s.frozenAgents, frozenTools: s.frozenTools });

/** Flip `id` in a frozen list (order kept, no duplicates). */
export function toggleFrozen(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

// ── Tool ownership (os.json `mcps[].agents`, the grant list) ────────────────

const SELF = ["general", "tony", "os", "dispatcher", "orchestrator", "jarvis"];
const canon = (a: string) => (SELF.includes(a.trim().toLowerCase()) ? "general" : a.trim().toLowerCase());

/** Does a grant list cover `agent` (Rust `McpServer::grants`: missing / empty / "all" = every
 * agent; Tony's aliases count as `general`)? Tony respects grants like everyone else now. */
export function ownsServer(grants: readonly string[] | null | undefined, agent: string): boolean {
  if (!grants || grants.length === 0) return true;
  const a = canon(agent);
  return grants.some((g) => g === "all" || canon(g) === a);
}

/**
 * Flip `agent`'s ownership of a server. `allIds` is every agent "all" stands for (Tony's
 * `general` included). A missing / empty list means "all", so it is spelled out first: unticking
 * one agent of an unrestricted server keeps everyone else.
 */
export function toggleOwner(grants: readonly string[] | null | undefined, agent: string, allIds: readonly string[]): string[] {
  const a = canon(agent);
  const cur = !grants || grants.length === 0 || grants.includes("all") ? [...allIds] : grants.map(canon);
  const next = cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a];
  // An empty list means EVERY agent to Rust: the last owner can't be removed (switch the server
  // off in the MCP registry instead).
  if (next.length === 0) return [...cur];
  // Registry order first, then any id this list knows that the registry doesn't (kept as is).
  return [...allIds.filter((id) => next.includes(id)), ...next.filter((x) => !allIds.includes(x))];
}
