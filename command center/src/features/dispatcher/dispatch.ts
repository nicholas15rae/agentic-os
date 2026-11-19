import { api, gateway } from "@/lib/gateway";
import { cmd, isTauri, type ChatMessage, type DispatchResult } from "@/lib/platform";
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

/**
 * Queue a turn payload for the desktop app and wait for its result (null if the desktop isn't
 * picking up within 12 s). Every current caller sends `noDelegate` (true or false), so the
 * desktop's legacy idea-shaped shortcut (`pipeline.rs inbox_turn_route`) never fires for them;
 * `capture: true` is an approved Tier-3 build "yes" (Prompter breakdown + ledger).
 */
export async function queueDesktopTurn(payload: Record<string, unknown> & { noDelegate: boolean }): Promise<DesktopResult | null> {
  const q = await gateway<{ id: string }>("/api/os/inbox", { method: "POST", body: JSON.stringify({ kind: "turn", payload }) });
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000) {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await gateway<{ status: string; result: { ok: boolean; result?: DesktopResult; error?: string } | null }>(`/api/os/inbox/${q.id}`);
    if (r.status === "pending") {
      if (Date.now() - t0 > 12_000) return null; // desktop app not running → fall back
      continue;
    }
    if (r.result?.ok && r.result.result) return r.result.result;
    throw new Error(r.result?.error ?? "desktop turn failed");
  }
  return null;
}

/**
 * Single entry point for "send this to the agents".
 *
 * Desktop: Rust `dispatch_chat` picks local vs cloud (GPU-load aware), injects
 * API keys from the OS keychain, and reports whether it fell back.
 * PWA:     the Agentic OS gateway (FastAPI) runs the agent; no keys in the browser.
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

  if (isTauri()) {
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
