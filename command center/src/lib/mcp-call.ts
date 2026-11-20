/**
 * The one way the webview runs an MCP tool (`mcp_call`): the calling agent is ALWAYS sent,
 * because Rust gates every non-Tony agent by role (Part 4, mcp.rs `role_refusal`), and the
 * role refusals are shown as "blocked by role" instead of a raw error string.
 */
import { cmd } from "./platform";

/** Rust refusal prefixes (mcp.rs). Longest first: `PERMISSION_READ_ONLY_ROLE:` also starts with `PERMISSION_READ_ONLY`. */
export const ROLE_PREFIX = "PERMISSION_ROLE:";
export const READ_ONLY_ROLE_PREFIX = "PERMISSION_READ_ONLY_ROLE:";
export const READ_ONLY_PREFIX = "PERMISSION_READ_ONLY:";

export interface McpCallOptions {
  /** Who is calling: "tony" for the OS's own calls and the Settings testers. */
  agent: string;
  approved?: boolean;
}

/** Run one tool as `opts.agent` (sent explicitly, never left to Rust's default). */
export function mcpCall(name: string, args: Record<string, unknown>, opts: McpCallOptions): Promise<string> {
  const agent = opts.agent.trim();
  if (!agent) return Promise.reject(new Error("mcpCall needs an agent"));
  return cmd("mcp_call", { name, args, agent, ...(opts.approved === undefined ? {} : { approved: opts.approved }) });
}

/** The text after `PREFIX:<who> — `. */
function reason(rest: string): string {
  const i = rest.indexOf(" — ");
  return i >= 0 ? rest.slice(i + 3) : rest;
}

/** A tool error for display: role refusals read "blocked by role: …", read-only servers
 * "blocked (read-only): …"; anything else is passed through. */
export function describeToolError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const msg = raw.replace(/^Error:\s*/, "");
  if (msg.startsWith(READ_ONLY_ROLE_PREFIX)) return `blocked by role: ${reason(msg.slice(READ_ONLY_ROLE_PREFIX.length))}`;
  if (msg.startsWith(ROLE_PREFIX)) return `blocked by role: ${reason(msg.slice(ROLE_PREFIX.length))}`;
  if (msg.startsWith(READ_ONLY_PREFIX)) return `blocked (read-only): ${reason(msg.slice(READ_ONLY_PREFIX.length))}`;
  return msg;
}

/** Whether an error is one of the role refusals. */
export function isRoleRefusal(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).replace(/^Error:\s*/, "");
  return msg.startsWith(ROLE_PREFIX) || msg.startsWith(READ_ONLY_ROLE_PREFIX);
}
