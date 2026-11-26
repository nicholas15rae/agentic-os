import { gateway } from "@/lib/gateway";
import type { AgentApi, AgentView } from "@/features/trading/AgentPanel.contract";

/**
 * Gateway client for the retired Trading Agent (implements the locked AgentApi contract): read-only.
 * The bridge answers /agent/run and /agent/enable with 410; Engine R (engineRApi in ibkr.ts) executes now.
 */
export const agentApi: AgentApi = {
  view: () => gateway<AgentView>("/api/trading/agent", { timeoutMs: 10_000 }),
};
