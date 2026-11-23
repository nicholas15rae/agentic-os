import type { AgentRole } from "@/features/dispatcher/agents";
import { roleLabel } from "@/features/dispatcher/roles";
import { directTool, isSelfRoleId, resolve, type Route, type RouteKind } from "@/features/dispatcher/router";
import type { RoutingConfig } from "@/lib/platform";
import { THREADS, type Channel, type ThreadId } from "./voice-store";

/**
 * The ONE routing decision for a desktop turn (P2). Pure: the voice controller asks this once
 * per turn (planner role and OS turn alike) and never re-implements routing.
 *
 * - A Named sub-agent always wins, on any tab, by voice or typed ("tell the coder…").
 * - A live-tool read question ("any WhatsApp updates?") is Tony's own tool path ("Direct").
 * - Addressing Tony himself ("thanks tony", "ask the dispatcher…") is Tony ("Self"), never a
 *   delegation to himself and never a routing notice.
 * - Voice is always Tony's conversation (U2): a Domain match delegates only from Auto; on any
 *   other tab (Tony's or a sub-agent's) the line stays with Tony ("Self": Tony answers himself,
 *   so Rust never re-promotes it). Voice never yields "Tab".
 * - Typed text keeps today's rules: Domain overrides only in Auto, otherwise the open tab wins.
 */
export interface RouteForInput {
  utterance: string;
  /** The thread this turn writes to (`tonyThread()` for voice). */
  thread: ThreadId;
  channel: Channel;
  cfg: RoutingConfig;
  /** The configured OS name (a self name, like "tony"). */
  osName?: string;
}

export type RoutedTurn = Route & { role: AgentRole };

export function routeFor({ utterance, thread, channel, cfg, osName = "" }: RouteForInput): RoutedTurn {
  const det = resolve(utterance, cfg, osName);
  if (det.kind === "Named" && det.role && !isSelfRoleId(det.role, osName)) return { ...det, role: det.role as AgentRole };
  const direct = directTool(utterance);
  if (direct) return { ...det, role: "general", kind: "Direct", reason: `live ${direct} tool` };
  if (det.kind === "Self" || (det.role && isSelfRoleId(det.role, osName))) return { ...det, role: "general", kind: "Self" };
  if (channel === "voice") {
    if (thread !== "auto") return { ...det, role: "general", kind: "Self", reason: `voice stays with ${osName || "Tony"} on this tab` };
    if (det.kind === "Domain" && det.role) return { ...det, role: det.role as AgentRole };
    return { ...det, role: "general" };
  }
  if (det.kind === "Domain" && det.role && thread === "auto") return { ...det, role: det.role as AgentRole };
  if (thread !== "auto") return { ...det, role: thread as AgentRole, kind: "Tab", reason: "current tab" };
  return { ...det, role: "general" };
}

/** The roles Solo (`surface_only`) keeps with Tony unless addressed by name (Rust `SOLO_HELD_ROLES`). */
const SOLO_HELD_ROLES: readonly string[] = ["prompter", "designer", "coder", "director"];

/**
 * Rust's Solo hold (agents.rs `route_for_turn`), mirrored so the webview never announces a
 * delegation Rust is about to keep with Tony ("Routing … to Coder…" + the handoff cue, then
 * Tony answers himself): under `surface_only`, a non-explicit Domain / Default hit or a
 * low-confidence mention of the Prompter / Designer / Coder / Director stays Tony's. Pure.
 */
export function soloHold(r: RoutedTurn, o: { explicit: boolean; dispatch: string | undefined }): RoutedTurn {
  if (o.dispatch !== "surface_only" || o.explicit || !SOLO_HELD_ROLES.includes(r.role)) return r;
  const named = r.kind === "Named";
  if (r.kind === "Domain" || r.kind === "Default" || (named && r.confidence !== "high")) return { ...r, role: "general", kind: "Self", reason: "Solo mode: kept with Tony" };
  return r;
}

/**
 * The one-line "Routing … to <agent>…" notice in Tony's thread, or null. Only a real delegation
 * gets one: never Tony himself (any self alias), never Self / Direct / Tab kinds, never an
 * explicit turn, never the agent whose thread this already is.
 */
export function routingNotice(o: { role: string; kind: RouteKind; explicit: boolean; thread: ThreadId; task: string; utterance: string }): string | null {
  if (o.explicit || isSelfRoleId(o.role) || o.role === o.thread) return null;
  if (o.kind !== "Named" && o.kind !== "Domain") return null;
  const task = o.task || o.utterance;
  const short = task.length > 60 ? `${task.slice(0, 57)}…` : task;
  return `Routing ${short} to ${roleLabel(o.role)}…`;
}

/** Speaker id → canonical agent ("os" and every self alias are Tony = "general"). */
const canonSpeaker = (id: string | undefined, osName: string) => {
  const v = (id ?? "").trim().toLowerCase();
  return v === "os" || isSelfRoleId(v, osName) ? "general" : v;
};

/** A relay from Tony to Tony ("TONY → TONY"): never pushed, never rendered. */
export const isSelfRelay = (t: { from?: string; to?: string }, osName = ""): boolean => canonSpeaker(t.from ?? "os", osName) === canonSpeaker(t.to ?? "user", osName);

/**
 * Where an OS-turn step belongs (U3: Tony's thread is a clean Nic↔Tony transcript):
 * - self relays: nowhere;
 * - delegate / reply steps and the delegated agent's own errors: that agent's tab;
 * - tool and step-in relays: the agent's tab when the turn was delegated, else the trace only
 *   (Rust already emits every hop on the System Map) — never Tony's thread.
 * Returns null when the step is not shown in any thread.
 */
export function relayThreadFor(step: { kind: string; from: string; to: string }, o: { finalRole: AgentRole; relayThread: ThreadId; tonyThread: ThreadId; osName?: string }): ThreadId | null {
  if (isSelfRelay(step, o.osName)) return null;
  const delegated = o.relayThread !== o.tonyThread;
  const agentStep = step.kind === "delegate" || step.kind === "reply" || (step.kind === "error" && step.from === o.finalRole);
  if (agentStep) {
    // The sub-agent's own tab (a Librarian comms lookup on Tony's own turn included).
    const agent = step.kind === "delegate" ? step.to : step.from;
    if (isSubAgentThread(agent)) return agent;
  }
  return delegated ? o.relayThread : null;
}

/** A sub-agent's thread (not Auto, not Tony's). */
export const isSubAgentThread = (t: string | undefined): t is ThreadId => !!t && t !== "auto" && t !== "general" && (THREADS as string[]).includes(t);
