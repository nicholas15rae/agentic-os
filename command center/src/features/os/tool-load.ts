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
/** Rust `mcp::finance_reader_refusal`: the read-only Finance server (`finance.ask`, Section 11.10)
 * is only ever handed to Tony and the finance role, whatever its grants say. */
export const FINANCE_SERVER = "finance";
const FINANCE_READERS = ["general", "finance"];
/** Rust `mcp::vault_reader_refusal`: the read-only vault search server (`vault.search`, Section 16.6)
 * is only ever handed to Tony, whatever its grants say. */
export const VAULT_SERVER = "vault";
const VAULT_READERS = ["general"];

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
      if (s.id === FINANCE_SERVER && !FINANCE_READERS.includes(agent)) return false;
      if (s.id === VAULT_SERVER && !VAULT_READERS.includes(agent)) return false;
      const always = ALWAYS_LIVE.includes(s.id);
      if (!always && o.frozenTools.includes(s.id)) return false;
      if (tony) return ownsServer(s.agents, "general") || extra.includes(s.id);
      return ownsServer(s.agents, agent) && (always || !o.modeTools || o.modeTools.includes(s.id));
    })
    .map((s) => s.id);
}

/** Rust `mcp::TONY_SPOTIFY_CORE` (Section 20.11): the Spotify tools Tony's router sees by name. */
export const TONY_SPOTIFY_CORE: readonly string[] = ["spotify.now_playing", "spotify.play", "spotify.resume", "spotify.pause", "spotify.next"];
/** Rust `mcp::spotify_more_info`: the one entry standing for every other Spotify tool. */
const SPOTIFY_MORE = { name: "spotify.more", description: "Any other Spotify action: action is one of get_queue, recently_played, top_items, list_playlists, get_playlist_tracks, previous, seek, restart_track, volume, shuffle, repeat, transfer_device, queue_add, create_playlist, add_to_playlist, remove_from_playlist, like_track, unlike_track; args are that action's own arguments. Spotify only.", args: ["action", "args?"] };

/** What one agent is handed of a listing: Tony gets Spotify's core plus `spotify.more`. */
function handed(agent: string, l: ServerTools): readonly { name: string; description: string; args: readonly string[] }[] {
  if (agent !== "general" || l.id !== "spotify") return l.tools;
  const core = l.tools.filter((t) => TONY_SPOTIFY_CORE.includes(t.name));
  return core.length < l.tools.length ? [...core, SPOTIFY_MORE] : core;
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
    const ts = handed(agent, l);
    tools += ts.length;
    tokens += ts.reduce((n, t) => n + toolTokens(t), 0);
  }
  return { agent, servers: [...servers], tools, tokens, unlisted, warn: tools > TOOL_WARN };
}

/** Section 21.1: servers shared on purpose, by exactly these owners: Maps (Tony + the Ops /
 * Job Desk agent) and Instagram (Biz Ops, Tony read-only). Never flagged as shared. */
export const INTENDED_SHARED: Readonly<Record<string, readonly string[]>> = {
  maps: ["general", "ops"],
  instagram: ["general", "bizops"],
};

/** The owners are (a subset of) the server's intended pair. */
const intended = (server: string, owners: readonly string[]) => !!INTENDED_SHARED[server] && owners.every((o) => INTENDED_SHARED[server].includes(o));

/** Servers more than one ACTIVE agent owns (`active`: Tony + the agents not frozen everywhere),
 * except the intended pairs (`INTENDED_SHARED`). */
export function sharedServers(mcps: readonly McpServer[], active: readonly string[]): { server: string; owners: string[] }[] {
  return mcps
    .filter((s) => s.enabled && !ALWAYS_LIVE.includes(s.id))
    .map((s) => ({ server: s.id, owners: active.filter((a) => ownsServer(s.agents, a)) }))
    .filter((x) => x.owners.length > 1 && !intended(x.server, x.owners));
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
