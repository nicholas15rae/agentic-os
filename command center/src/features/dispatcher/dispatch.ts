import { api, gateway } from "@/lib/gateway";
import { cmd, type ChatMessage, type DispatchResult } from "@/lib/platform";
import { isDesktopApp } from "@/stores/settings";
import { SUB_AGENTS, type AgentRole } from "./agents";
import { DEFAULT_ROUTING_CONFIG, directTool, resolve } from "./router";

export interface DispatchOutcome {
  role: AgentRole;
  result: DispatchResult;
}

export interface DispatchOptions {
  role?: AgentRole;
  history?: ChatMessage[];
  /** Force a provider id (desktop only). */
  provider?: string;
  /** P3 Tier 2: Tony brainstorms this himself — the queued phone turn carries `noDelegate`, so
   * the desktop never re-routes it and never runs the Prompter's idea capture. */
  noDelegate?: boolean;
}

/** The desktop's answer to a queued phone item (`result` of `/api/os/inbox/{id}`). */
export type DesktopResult = { answer?: string; providerId?: string; idea?: { id?: string; title?: string } } & Record<string, unknown>;

/** Gateway queue item states (`os_queue.status`). `failed` is what gateways before the claim/lease
 * change wrote for an error, so it is still understood. */
export type QueueStatus = "pending" | "running" | "done" | "error" | "failed" | "expired";

/** How long an unclaimed item may sit `pending` before the phone assumes the desktop is off. */
export const DESKTOP_PICKUP_MS = 12_000;
/** Hard cap on waiting for a claimed (`running`) item. */
export const DESKTOP_ANSWER_CAP_MS = 240_000;
export const DESKTOP_POLL_MS = 1500;
export const DESKTOP_EXPIRED_MESSAGE = "The desktop app didn't pick that up in time, so nothing ran.";

/**
 * Queue a turn payload for the desktop app and wait for its result. Returns null only when the
 * item is still unclaimed (`pending`) after 12 s (desktop app not running) or the 240 s cap runs
 * out; once the desktop has claimed it (`running`) the phone keeps waiting, because a Prompter
 * capture alone can take minutes. `expired` (the gateway gave up on it) throws an explicit message.
 * Every current caller sends `noDelegate` (true or false), so the desktop's legacy idea-shaped
 * shortcut (`pipeline.rs inbox_turn_route`) never fires for them; `capture: true` is an approved
 * Tier-3 build "yes" (Prompter breakdown + ledger).
 */
export async function queueDesktopTurn(payload: Record<string, unknown> & { noDelegate: boolean }): Promise<DesktopResult | null> {
  return queueDesktopItem("turn", payload);
}

/**
 * Queue any inbox item for the desktop and wait for its result (same pickup / cap / expired rules
 * as `queueDesktopTurn`). A desktop refusal (e.g. the mode gate's `MODE_SURFACE_ONLY` /
 * `MODE_NOT_AUTO` on a `task`) throws its error text, so the caller never claims success.
 */
/** The desktop is working through the inbox: busy with another item, or polled in the last 15 s. */
export function desktopAlive(r: { desktopSeenAt?: number; desktopBusy?: boolean }, nowMs = Date.now()): boolean {
  return !!r.desktopBusy || (!!r.desktopSeenAt && nowMs / 1000 - r.desktopSeenAt < 15);
}

export async function queueDesktopItem(kind: "turn" | "task" | "pipeline", payload: Record<string, unknown>, opts: { capMs?: number } = {}): Promise<DesktopResult | null> {
  const q = await gateway<{ id: string }>("/api/os/inbox", { method: "POST", body: JSON.stringify({ kind, payload }) });
  const t0 = Date.now();
  const cap = opts.capMs ?? DESKTOP_ANSWER_CAP_MS;
  while (Date.now() - t0 < cap) {
    await new Promise((r) => setTimeout(r, DESKTOP_POLL_MS));
    const r = await gateway<{ status: QueueStatus; result: { ok: boolean; result?: DesktopResult; error?: string } | null; desktopSeenAt?: number; desktopBusy?: boolean }>(`/api/os/inbox/${q.id}`);
    if (r.status === "pending") {
      // Not picked up yet. Fall back only when there's no desktop app: one that is busy with an earlier
      // turn (it takes them one at a time) or polled lately will answer, so keep waiting for Tony.
      if (Date.now() - t0 > DESKTOP_PICKUP_MS && !desktopAlive(r)) return null;
      continue;
    }
    if (r.status === "running") continue; // claimed: the desktop is working on it
    if (r.status === "expired") throw new Error(DESKTOP_EXPIRED_MESSAGE);
    if (r.result?.ok && r.result.result) return r.result.result;
    throw new Error(r.result?.error ?? `desktop ${kind} failed`);
  }
  return null;
}

/**
 * Single entry point for "send this to the agents".
 *
 * Desktop: Rust `dispatch_chat` picks local vs cloud (GPU-load aware), injects
 * API keys from the OS keychain, and reports whether it fell back.
 * PWA and the Android app: the turn is queued for the desktop's Tony through the gateway (its Rust
 *          side runs on the phone, where 127.0.0.1 isn't the PC); the gateway's own agent is the fallback.
 */
/** Queue a turn for the desktop app and wait for the answer (null if the desktop isn't picking up). */
async function desktopTurn(
  text: string,
  role: AgentRole,
  explicit: boolean,
  routeKind: string,
  routeReason: string,
  history: ChatMessage[],
  noDelegate: boolean,
): Promise<{ answer: string; providerId?: string } | null> {
  const r = await queueDesktopTurn({ text, role, explicit, routeKind, routeReason, history: history.slice(-8), context: "", noDelegate });
  if (!r) return null;
  if (!r.answer) throw new Error("desktop turn failed");
  return { answer: r.answer, providerId: r.providerId };
}

export async function dispatch(text: string, opts: DispatchOptions = {}): Promise<DispatchOutcome> {
  // Phone/PWA has no live sync of the user's custom routing matrix yet, so it
  // resolves against the shared defaults — still far better than the old
  // keyword classifier, and "explicit" now means an actually-Named route
  // rather than "any role other than general" (previously *every* classified
  // role was treated as explicit, so a wrong keyword guess went straight to
  // that agent's raw reply with no Tony synthesis or fallback).
  const resolved = resolve(text, DEFAULT_ROUTING_CONFIG);
  // A live-tool read question ("any WhatsApp updates?") is Tony's own tool path on any tab;
  // only a Named delegation keeps its agent (Rust applies the same backstop to inbox turns).
  const direct = resolved.kind === "Named" ? null : directTool(text);
  const routed = direct ? { ...resolved, role: "general", kind: "Direct" as const, reason: `live ${direct} tool` } : resolved;
  // "Self" (the line addresses Tony himself: "thanks tony", "ask the dispatcher…") is Tony,
  // never explicit — Rust then answers as Tony and never re-promotes it.
  const role = direct || routed.kind === "Self" || opts.noDelegate ? "general" : (opts.role ?? (routed.role as AgentRole) ?? "general");
  const explicit = !direct && !opts.role && !opts.noDelegate && routed.kind === "Named";
  // Tier 2: Tony keeps it ("Self"), whatever the default table read into it.
  const routeKind = opts.noDelegate && !direct ? "Self" : routed.kind;
  const routeReason = opts.noDelegate && !direct ? "brainstorm with Tony (Tier 2)" : routed.reason;
  const agent = SUB_AGENTS[role];

  if (isDesktopApp()) {
    const messages: ChatMessage[] = [
      { role: "system", content: agent.systemPrompt },
      ...(opts.history ?? []).slice(-10),
      { role: "user", content: text },
    ];
    const result = await cmd("dispatch_chat", { req: { messages, priority: agent.priority, provider: opts.provider } });
    return { role, result };
  }

  const started = performance.now();
  // Phone: queue the turn for the desktop's OS core (same Tony, tools, sub-agents).
  const viaDesktop = await desktopTurn(text, role, explicit, routeKind, routeReason, opts.history ?? [], !!opts.noDelegate).catch(() => null);
  if (viaDesktop) {
    return {
      role,
      result: { providerId: `desktop:${viaDesktop.providerId ?? "tony"}`, content: viaDesktop.answer, fellBack: false, reason: "phone → desktop Tony", latencyMs: Math.round(performance.now() - started) },
    };
  }
  const res = await api.chat(agent.gatewayAgent, `[${agent.label}] ${text}`);
  return {
    role,
    result: {
      providerId: `gateway:${agent.gatewayAgent}`,
      content: res.response?.content ?? "",
      fellBack: false,
      reason: "PWA → Agentic OS gateway",
      latencyMs: Math.round(performance.now() - started),
    },
  };
}
