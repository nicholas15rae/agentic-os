/**
 * Wire types of the Agent Conversation transcript (Rust `transcript.rs`, camelCase). Everything
 * here was scrubbed and capped in Rust before it was stored; the webview only reads it.
 */

export type TranscriptKind = "prompt" | "reply" | "handoff" | "status" | "question" | "answer" | "override" | "repair" | "smoke" | "error" | "retry" | "note";
export type ConversationKind = "task" | "hub" | "turn" | "dev";

export interface TranscriptConversation {
  convId: string;
  kind: ConversationKind;
  title: string;
  /** The chat thread its card lands in (a ThreadId; "auto" = Tony's main thread). */
  thread: string;
  parentConvId: string | null;
  taskId: string | null;
  status: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Messages not stored past the per-conversation cap. */
  dropped: number;
  lastFrom: string | null;
  lastTo: string | null;
  lastSummary: string | null;
  lastKind: string | null;
}

/** A message without its body (what the live event and a page carry). */
export interface TranscriptHead {
  seq: number;
  convId: string;
  at: number;
  from: string;
  to: string;
  kind: TranscriptKind;
  stage: string | null;
  iteration: number | null;
  summary: string;
  bodyChars: number;
  originalChars: number;
  truncated: boolean;
  ok: boolean;
  handoffSeq: number | null;
}

export interface TranscriptMessage extends TranscriptHead {
  body: string;
}

/** Payload of the `agent-transcript` event. */
export interface TranscriptEvent {
  conv: TranscriptConversation;
  message: TranscriptHead;
}

export interface TranscriptPage {
  conv: TranscriptConversation;
  messages: TranscriptHead[];
  children: TranscriptConversation[];
  more: boolean;
}
