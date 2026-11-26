import { api, GatewayError } from "@/lib/gateway";
import { cc } from "@/lib/cc-api";
import { cmd, type ChatMessage } from "@/lib/platform";
import { SUB_AGENTS } from "@/features/dispatcher/agents";
import { APPROVED_ACTION_TOOLS, dispatch, sendApprovedAction, type ApprovedActionTool } from "@/features/dispatcher/dispatch";
import type { LearnedPathway, PendingMemory } from "@/features/modes/learning";
import { isDesktopApp } from "@/stores/settings";
import { namesOwnCalendar, type CalendarArgs } from "./calendar-add";
import type { ActionPlan } from "./plan";

export interface ExecutionResult {
  text: string;
  meta: string;
  /** A phone turn the desktop's Tony answered in Learning mode (decision 5): his proposals (the
   * card) and the core memories a yes saved (the pills), as `dispatch` returned them. */
  pendingMemory?: PendingMemory[];
  learned?: LearnedPathway[];
}

/**
 * Run a plan. Only call this for read-only plans, or for mutating plans the
 * human has approved. The ONLY caller is the controller's approval path.
 *
 * Routing:
 *   read-only        → dispatch() chat (local model / cloud fallback / gateway)
 *   mutating + n8n   → named n8n webhook (Rust, URL from providers.json)
 *   mutating + tool  → that tool's approved-only Rust command (gmail_create_draft,
 *                      gcal_create_event, instagram_publish_post, instagram_reply_comment);
 *                      on the phone a calendar add / Gmail draft is an approved `action`
 *                      inbox item the desktop runs the same way (`sendApprovedAction`)
 *   mutating + agent → Agentic OS agent via the gateway (opencode has real
 *                      tools). A plain chat model has NO tools and would
 *                      only *claim* it acted, so it is never used to
 *                      "execute" a mutating action. Before sending, the
 *                      agent's health is checked so an uninstalled CLI never
 *                      shows a fake reply. The phone does exactly the same: a
 *                      desktop inbox turn (`os_turn`) has no mutating tools,
 *                      so an approved action is never queued for Tony there.
 */
export async function execute(plan: ActionPlan, history: ChatMessage[]): Promise<ExecutionResult> {
  const agent = SUB_AGENTS[plan.role];

  // Permission-Bridge actions carry their own (already approved) runner.
  if (plan.run) return plan.run();

  if (!plan.mutating && plan.target.kind === "n8n") {
    // Read-only workflow (e.g. calendar-upcoming): Rust refuses this for mutating ones.
    const started = performance.now();
    const out = await cmd("n8n_fetch", { name: plan.target.workflow, payload: { ...plan.payload, utterance: plan.utterance } });
    return {
      text: summariseOutput(typeof out === "string" ? out : JSON.stringify(out)),
      meta: `n8n · ${plan.target.workflow} (read-only) · ${Math.round(performance.now() - started)}ms`,
    };
  }

  if (!plan.mutating) {
    // Librarian answers from your own vault (notes, scripts, jobs…) when it can. Never finance records:
    // the Librarian has web access, so receipts / invoices / cheques / income stay out of its context.
    let utterance = plan.utterance;
    let vaultNote = "";
    if (plan.role === "librarian") {
      const hits = await cc.agentSearch(plan.utterance, 5).catch(() => null);
      if (hits?.results.length) {
        utterance = `${plan.utterance}\n\nRelevant entries from my local vault (cite them; say if they don't answer it):\n${hits.results
          .map((r, i) => `[${i + 1}] (${r.collection}) ${r.snippet.replace(/\s+/g, " ")}`)
          .join("\n")}`;
        vaultNote = ` · vault ${hits.results.length} (${hits.mode})`;
      }
    }
    // The plan's route kind goes along as `routeFor` decided it: a phone turn it kept with Tony
    // reaches the desktop as "Self" (never re-resolved); a plain no-match stays "Default".
    const { result, pendingMemory, learned } = await dispatch(utterance, { role: plan.role, history, noDelegate: plan.noDelegate, routeKind: plan.routeKind });
    return {
      text: result.content || "(no response)",
      meta: `${agent.label} · ${result.providerId}${result.fellBack ? " · fallback" : ""}${vaultNote} · ${result.latencyMs}ms`,
      ...(pendingMemory?.length ? { pendingMemory } : {}),
      ...(learned?.length ? { learned } : {}),
    };
  }

  if (plan.target.kind === "tool") return runTool(plan.target.tool, plan.target.args, plan.id);

  if (plan.target.kind === "n8n") {
    const started = performance.now();
    const out = await cmd("n8n_trigger", {
      name: plan.target.workflow,
      payload: { ...plan.payload, intent: plan.intent, summary: plan.summary, utterance: plan.utterance, approvedAt: new Date().toISOString() },
    });
    return {
      text: `Done — the ${plan.target.workflow} workflow ran.${out ? ` ${summariseOutput(out)}` : ""}`,
      meta: `n8n · ${plan.target.workflow} · ${Math.round(performance.now() - started)}ms`,
    };
  }

  // Guard: an approved action on Nic's own calendar never goes to a gateway agent (it has no
  // calendar tool and could only claim it acted). Calendar adds run through `gcal_create_event`.
  if (calendarActionForAgent(plan)) {
    throw new Error('Nothing was done — calendar adds go through Google Calendar. Say it like "add the shoot to my calendar for Friday at 7 AM".');
  }

  // Guard: never send to a gateway agent that isn't installed — fail with a plain
  // message instead of letting the gateway's "⚠ CLI not installed" text show as a
  // reply (server.py now returns 503 for that too; this check avoids the round trip).
  const health = await api.agentsHealth().catch(() => null);
  const status = health?.agents.find((a) => a.name === agent.gatewayAgent)?.status;
  if (status && status !== "online") {
    throw new Error(`Nothing was done — the ${agent.gatewayAgent} CLI isn't installed.`);
  }

  const started = performance.now();
  const message = [
    `[${agent.label} — action APPROVED by the user]`,
    `Action: ${plan.summary}`,
    `Details: ${JSON.stringify(plan.payload)}`,
    `Original request: "${plan.utterance}"`,
    "Carry out exactly this action and nothing more. If you cannot complete it, say so plainly — do not claim success. Reply in one or two sentences.",
  ].join("\n");
  const res = await api.chat(agent.gatewayAgent, message).catch((e) => {
    if (e instanceof GatewayError && e.status === 503) {
      throw new Error(`Nothing was done — the ${agent.gatewayAgent} CLI isn't installed.`);
    }
    throw new Error(`Executor unreachable (${e instanceof Error ? e.message : e}) — nothing was done.`);
  });
  return {
    text: res.response?.content || "(no response)",
    meta: `${agent.label} → Agentic OS · ${agent.gatewayAgent} · ${Math.round(performance.now() - started)}ms`,
  };
}

/** An approved tool plan: each tool has its own Rust command that refuses without `approved`.
 * Off the desktop (the Android app) a calendar add or Gmail draft goes to the desktop as an
 * approved `action` inbox item, run through the same approved-only path; never a gateway agent. */
async function runTool(tool: string, args: Record<string, unknown>, planId: string): Promise<ExecutionResult> {
  const started = performance.now();
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  const denied = (what: string) => (e: unknown): never => {
    const raw = e instanceof Error ? e.message : String(e);
    throw new Error(raw.startsWith("PERMISSION_DENIED") ? "Nothing was done — MCP tools are set to Deny in Settings → Integrations." : `${what} — ${raw}`);
  };
  if (!isDesktopApp() && (APPROVED_ACTION_TOOLS as readonly string[]).includes(tool)) {
    const text = await sendApprovedAction(tool as ApprovedActionTool, args, planId);
    return { text, meta: `${tool === "calendar.create_event" ? "Google Calendar · add" : "Gmail · draft"} · via the desktop · ${Math.round(performance.now() - started)}ms` };
  }
  if (tool === "calendar.create_event") {
    const text = await cmd("gcal_create_event", { args: args as unknown as CalendarArgs, approved: true }).catch(denied("Nothing was added to your calendar"));
    return { text, meta: `Google Calendar · add · ${Math.round(performance.now() - started)}ms` };
  }
  if (tool === "instagram.publish_post") {
    const text = await cmd("instagram_publish_post", { caption: s("caption"), imageUrl: s("imageUrl") || undefined, videoUrl: s("videoUrl") || undefined, approved: true }).catch(denied("Nothing was published"));
    return { text, meta: `Instagram · publish · ${Math.round(performance.now() - started)}ms` };
  }
  if (tool === "instagram.reply_comment") {
    const text = await cmd("instagram_reply_comment", { commentId: s("commentId"), message: s("message"), approved: true }).catch(denied("No reply was posted"));
    return { text, meta: `Instagram · reply · ${Math.round(performance.now() - started)}ms` };
  }
  if (tool !== "gmail.create_draft") throw new Error(`Nothing was done — ${tool} has no approved-action path.`);
  const text = await cmd("gmail_create_draft", { to: s("to"), subject: s("subject"), body: s("body"), approved: true }).catch((e) => {
    const raw = e instanceof Error ? e.message : String(e);
    throw new Error(raw.startsWith("PERMISSION_DENIED") ? "Nothing was done — MCP tools are set to Deny in Settings → Integrations." : `No draft was saved — ${raw}`);
  });
  return { text, meta: `Gmail · draft · ${Math.round(performance.now() - started)}ms` };
}

/** A mutating agent-target plan whose words (the request, the model's intent / summary, or its
 * payload) are about Nic's own calendar. Pure. */
export function calendarActionForAgent(plan: Pick<ActionPlan, "mutating" | "target" | "utterance" | "intent" | "summary" | "payload">): boolean {
  if (!plan.mutating || plan.target.kind !== "agent") return false;
  return [plan.utterance, plan.intent, plan.summary, JSON.stringify(plan.payload ?? {})].some((t) => namesOwnCalendar(t));
}

function summariseOutput(raw: string): string {
  try {
    const j = JSON.parse(raw);
    const msg = j?.message ?? j?.result ?? j?.status;
    if (typeof msg === "string") return msg.slice(0, 200);
  } catch {
    /* plain text */
  }
  return raw.replace(/\s+/g, " ").slice(0, 200);
}
