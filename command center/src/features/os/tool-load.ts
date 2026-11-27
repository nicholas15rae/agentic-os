import type { McpServer, ServerTools } from "@/lib/platform";
import { ownsServer } from "./switchboard";

/**
 * Section pass, MCP & tool registry: what each agent is actually handed per turn (tool count and
 * a rough prompt-token cost), Tony's per-mode extras (os.json `tonyModeTools`, mirrors Rust
 * `os_core::default_tony_mode_tools`) and which servers more than one active agent owns. Pure.
 */

/** Rust `default_tony_mode_tools`: what each mode adds to Tony's always-on base. */
export const DEFAULT_TONY_MODE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  builder: ["git", "filesystem"],
  operations: ["maps", "instagram", "fetch"],
  executive: ["fetch"],
};

/** Above this many tools an agent's prompt gets heavy and its tool choice gets worse. */
export const TOOL_WARN = 10;
/** Per-tool framing the prompt adds around name + description + args (bullets, separators). */
const TOOL_OVERHEAD_TOKENS = 8;
/** Rust `ALWAYS_LIVE_SERVERS`. */
const ALWAYS_LIVE = ["time", "skills", "tony"];

export type TonyModeTools = Record<string, string[]>;

/** os.json's map, or the defaults when an older config has none. */
export function tonyModeTools(cfg: { tonyModeTools?: TonyModeTools | null }): TonyModeTools {
  if (cfg.tonyModeTools && typeof cfg.tonyModeTools === "object") return cfg.tonyModeTools;
  return Object.fromEntries(Object.entries(DEFAULT_TONY_MODE_TOOLS).map(([k, v]) => [k, [...v]]));
}

/** Toggle `server` in mode `modeId`'s extras (a new object). */
export function toggleTonyModeTool(map: TonyModeTools, modeId: string, server: string): TonyModeTools {
  const cur = map[modeId] ?? [];
  const next = cur.includes(server) ? cur.filter((s) => s !== server) : [...cur, server];
  return { ...map, [modeId]: next };
}

/** ~chars/4 for one tool as the model sees it. */
export function toolTokens(t: { name: string; description: string; args: readonly string[] }): number {
  return Math.ceil((t.name.length + t.description.length + t.args.join(", ").length) / 4) + TOOL_OVERHEAD_TOKENS;
}

export interface AgentLoad {
  agent: string;
  /** Server ids handed to the agent this turn. */
  servers: string[];
  /** Tools on those servers (listed ones only). */
  tools: number;
  tokens: number;
  /** Servers it gets whose tool list isn't known yet (not listed / not running). */
  unlisted: string[];
  warn: boolean;
}

interface LoadCfg {
  mcps: readonly McpServer[];
  tonyModeTools?: TonyModeTools | null;
}

/**
 * The servers `agent` gets this turn: Tony = his grants (always on) + the active mode's extras;
 * everyone else = grants ∩ the mode's live servers. A frozen agent gets none. `frozenTools` is the
 * master switchboard; `modeTools` the active mode's overlay (null = every server).
 */
export function agentServers(cfg: LoadCfg, agent: string, o: { modeId: string; modeTools: readonly string[] | null; frozenTools: readonly string[]; frozen: boolean }): string[] {
  if (o.frozen) return [];
  const tony = agent === "general";
  const extra = tony ? (tonyModeTools(cfg)[o.modeId] ?? []) : [];
  return cfg.mcps
    .filter((s) => {
      if (!s.enabled) return false;
      const always = ALWAYS_LIVE.includes(s.id);
      if (!always && o.frozenTools.includes(s.id)) return false;
      if (tony) return ownsServer(s.agents, "general") || extra.includes(s.id);
      return ownsServer(s.agents, agent) && (always || !o.modeTools || o.modeTools.includes(s.id));
    })
    .map((s) => s.id);
}

/** Count and token cost of `servers`, from the cached listings. */
export function loadOf(agent: string, servers: readonly string[], listed: readonly ServerTools[]): AgentLoad {
  let tools = 0;
  let tokens = 0;
  const unlisted: string[] = [];
  for (const id of servers) {
    const l = listed.find((x) => x.id === id);
    if (!l || !l.ok) {
      unlisted.push(id);
      continue;
    }
    tools += l.tools.length;
    tokens += l.tools.reduce((n, t) => n + toolTokens(t), 0);
  }
  return { agent, servers: [...servers], tools, tokens, unlisted, warn: tools > TOOL_WARN };
}

/** Servers more than one ACTIVE agent owns (`active`: Tony + the agents not frozen everywhere). */
export function sharedServers(mcps: readonly McpServer[], active: readonly string[]): { server: string; owners: string[] }[] {
  return mcps
    .filter((s) => s.enabled && !ALWAYS_LIVE.includes(s.id))
    .map((s) => ({ server: s.id, owners: active.filter((a) => ownsServer(s.agents, a)) }))
    .filter((x) => x.owners.length > 1);
}

/** The key a "yes, shared on purpose" answer is stored under: a new owner asks again. */
export const sharedKey = (x: { server: string; owners: readonly string[] }) => `${x.server}:${[...x.owners].sort().join(",")}`;

const ACK_KEY = "cc.sharedToolsOk";
export function loadSharedOk(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ACK_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
export function saveSharedOk(keys: readonly string[]): void {
  try {
    localStorage.setItem(ACK_KEY, JSON.stringify(keys));
  } catch {
    /* per-viewer convenience only */
  }
}
