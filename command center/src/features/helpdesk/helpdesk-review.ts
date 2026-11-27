import type { ChatMessage } from "@/lib/platform";
import type { VoiceTurn } from "@/features/voice/voice-store";

/**
 * Comms help desk ("Something's off"). ON DEMAND ONLY: one button reviews the last few turns of
 * the open thread with the Claude CLI (a CLOUD service: the turns leave this PC, through the
 * privacy diffuser and the kill switch / LOCAL ONLY / cloud-permission gates of `overseer_ask`),
 * and the diagnosis is saved as a fix ticket in the Claude Code fix queue
 * (`.agenticos/claude-fix-queue.json`, `/fix-queue`). Nothing here ever runs automatically.
 */

/** Turns sent for review. */
export const HELPDESK_TURNS = 8;
/** The engine the help desk always uses (not the Overseer setting). */
export const HELPDESK_ENGINE = "claude-cli";

export const HELPDESK_QUESTION = `Nic pressed "Something's off" on this conversation with his AI OS (Tony and his sub-agents, a Tauri desktop app with local LLMs, MCP tools and voice). Diagnose what went wrong in the LAST few turns: a wrong or dropped answer, the wrong tool or data source, a misroute to the wrong agent, a refusal, a slow turn (the [meta] tags show the provider and latency), or a voice problem.
Reply in exactly this shape, plain text, no preamble:
TITLE: <one line, under 80 characters, naming the bug>
WHAT HAPPENED: <1-3 sentences>
LIKELY CAUSE: <where in the app it probably comes from: routing, tool choice, prompt, model, voice, memory>
SUGGESTED FIX: <concrete steps a developer (Claude Code) can take>
If nothing looks wrong, say TITLE: No problem found, and explain briefly.`;

/** The last `n` user / agent turns of `thread`, oldest first, with each answer's meta tag. Pure. */
export function helpdeskTranscript(turns: readonly VoiceTurn[], thread: string, n = HELPDESK_TURNS): ChatMessage[] {
  return turns
    .filter((t) => t.thread === thread && (t.who === "user" || t.who === "agent"))
    .slice(-n)
    .map((t) => ({
      role: t.who === "user" ? "user" : "assistant",
      content: t.who === "agent" && t.meta ? `${t.text}\n[meta: ${t.from ? `${t.from} · ` : ""}${t.meta}]` : t.text,
    }));
}

/** The ticket title: the "TITLE:" line, else the first line, clipped; a fallback when empty. Pure. */
export function diagnosisTitle(answer: string): string {
  const m = /^\s*TITLE:\s*(.+)$/im.exec(answer);
  const line = (m?.[1] ?? answer.split("\n").find((l) => l.trim()) ?? "").trim();
  const t = line.length > 100 ? `${line.slice(0, 99)}…` : line;
  return t || "Something's off (help desk)";
}

/** "No problem found" diagnoses are shown but never saved as a ticket. Pure. */
export const noProblem = (answer: string) => /^\s*TITLE:\s*no problem found\b/im.test(answer);

/** The ticket body: the diagnosis, then the reviewed turns (already scrubbed by Rust's queue). Pure. */
export function ticketBody(answer: string, transcript: readonly ChatMessage[], thread: string): string {
  const turns = transcript.map((m) => `${m.role === "user" ? "Nic" : "Agent"}: ${m.content}`).join("\n");
  return `${answer.trim()}\n\n--- Reviewed turns (thread: ${thread}, via the Comms help desk) ---\n${turns}`.slice(0, 8000);
}
