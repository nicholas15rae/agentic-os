import { usePoll } from "@/lib/use-poll";
import { agentApi } from "@/features/trading/agent-api";
import type { AgentView } from "@/features/trading/AgentPanel.contract";

/** The Trading Agent's live view (config, on/off, last runs) for the System Map. null until loaded or when unreachable. */
export function useTradingAgent(intervalMs = 30_000): { view: AgentView | null; error: string | null } {
  const { data, error } = usePoll<AgentView>(agentApi.view, intervalMs);
  return { view: data, error };
}

/** "qwen/qwen3.5-9b" → "qwen3.5-9b". */
export const shortModel = (m: string | undefined | null): string | null => (m ? (m.split("/").pop() ?? m) : null);
