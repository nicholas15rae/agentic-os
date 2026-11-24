import { gateway } from "@/lib/gateway";
import type { AgentApi, AgentRun, AgentView } from "@/features/trading/AgentPanel.contract";

/** Gateway client for the Trading Agent (implements the locked AgentApi contract). */
export const agentApi: AgentApi = {
  view: () => gateway<AgentView>("/api/trading/agent", { timeoutMs: 10_000 }),
  // A run includes one local-model call that may first wait for Tony's GPU turn (up to 90 s).
  run: (submit: boolean) => gateway<AgentRun>("/api/trading/agent/run", { method: "POST", body: JSON.stringify({ submit }), timeoutMs: 330_000 }),
  enable: (enabled: boolean) => gateway<{ enabled: boolean }>("/api/trading/agent/enable", { method: "POST", body: JSON.stringify({ enabled }), timeoutMs: 10_000 }),
};
