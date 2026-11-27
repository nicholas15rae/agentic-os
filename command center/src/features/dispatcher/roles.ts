import { osName, useOs } from "@/features/os/os-store";
import { SELF_ROLE_IDS, isSelfRoleId } from "./router";

/**
 * The ONE shared list of agent role ids (Tony first, then the sub-agents in routing
 * tie-break order). `general` is Tony; "tony" is accepted as an alias in config/UI input.
 */
export const ROLE_IDS = ["general", "booking", "prompter", "coder", "designer", "director", "librarian", "ops", "bizops", "finance"] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export const isRoleId = (s: string): s is RoleId => (ROLE_IDS as readonly string[]).includes(s);

/** Every id that means Tony himself (general, tony, os, dispatcher, orchestrator, jarvis);
 * the configured OS name counts too (`isSelfRole`). */
export const SELF_ROLE_ALIASES = SELF_ROLE_IDS;

/** `id` is Tony (a self alias or the OS name, any case): never a delegation target. */
export const isSelfRole = (id: string | null | undefined): boolean => !!id && isSelfRoleId(id, osName());

/** Any self alias ("tony", "dispatcher", the OS name…) → "general"; anything unknown → null. */
export function toRoleId(s: string): RoleId | null {
  const v = s.trim().toLowerCase();
  if (isSelfRole(v)) return "general";
  return isRoleId(v) ? v : null;
}

/** Display label: general → the OS name ("Tony"), booking → "Booking Desk", others capitalised
 * word by word (`security-patrol` → "Security Patrol", like Rust `agents::role_label`). */
export function roleLabel(id: string): string {
  if (isSelfRole(id)) return osName();
  if (id === "booking") return "Booking Desk";
  if (id === "bizops") return "Biz Ops";
  const words = id.split(/[-_]/).filter(Boolean);
  if (words.length === 0) return id;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Every sub-agent (not Tony), in the order Part 2's drawer pills use: Booking
 * Desk · Coder · Prompter · Designer · Director · Librarian · Ops · Biz Ops · Finance. */
export const SUB_AGENT_IDS = ["booking", "coder", "prompter", "designer", "director", "librarian", "ops", "bizops", "finance"] as const;

const REGISTRY_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Registry ids beyond the static list (os.json `routing.agents` keys), A→Z: valid, not Tony. */
function registryExtras(agents: Record<string, unknown> | null | undefined, known: readonly string[]): string[] {
  return Object.keys(agents ?? {})
    .filter((id) => REGISTRY_ID_RE.test(id) && !known.includes(id) && !isSelfRole(id))
    .sort();
}

/**
 * Every role id at runtime (Phase 2 §4 prep): the static `ROLE_IDS` first, then any id the
 * routing registry (`routing.agents`) adds later — a future Security Patrol or Finance agent shows
 * up with no code change. `agents` defaults to the live os.json; the static list is the fallback.
 */
export function roleIds(agents: Record<string, unknown> | null | undefined = currentAgents()): string[] {
  return [...ROLE_IDS, ...registryExtras(agents, ROLE_IDS)];
}

/** Every sub-agent id at runtime (not Tony): `SUB_AGENT_IDS`, then registry extras A→Z. */
export function subAgentIds(agents: Record<string, unknown> | null | undefined = currentAgents()): string[] {
  return [...SUB_AGENT_IDS, ...registryExtras(agents, ROLE_IDS)];
}

function currentAgents(): Record<string, unknown> | null {
  try {
    return useOs.getState().cfg?.routing?.agents ?? null;
  } catch {
    return null;
  }
}

/**
 * Toggle `id` in a grant list that treats `"all"` as a wildcard for every
 * agent (used by both MCP server grants and skill grants, which both accept
 * it). `allIds` is every concrete agent id "all" stands in for.
 *
 * - Toggling `"all"` itself is a plain on/off: on → `["all"]`, off → `[]`.
 * - Toggling a concrete id while `"all"` is active expands to an explicit
 *   list of every id except the one just turned off (same resulting access,
 *   now spelled out) rather than silently doing nothing.
 * - Otherwise it's a normal add/remove from the explicit list.
 */
export function toggleGrant(list: string[], id: string, allIds: readonly string[]): string[] {
  const isAll = list.includes("all");
  if (id === "all") return isAll ? [] : ["all"];
  if (isAll) return allIds.filter((a) => a !== id);
  return list.includes(id) ? list.filter((a) => a !== id) : [...list, id];
}
