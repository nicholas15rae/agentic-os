/**
 * Director chat: one typed turn to the Director's own `director_turn` command (director.rs): the
 * Director persona + craft guide, this project's context and history, on the local chat chain.
 * OUTSIDE Tony's voice pipeline and routing (no voice store, no TTS, nothing in Tony's thread, no
 * Tony persona). `tony-token` deltas for this turn's own stream id stream into this page's bubble;
 * each message is appended to the project's chat log (media_chat_log). Action blocks in the reply
 * only fill the UI.
 */
import { onNativeEvent, type ChatMessage } from "@/lib/platform";
import { api } from "./api";
import type { DirectorAction, DirectorTurnRequest } from "./contract";
import { parseDirectorActions } from "./actions";
import { buildDirectorContext } from "./context";
import { applyDirectorActions, useDirector, type ChatMsg } from "./director-store";

export const HISTORY_TURNS = 10;

/** The last ~10 turns of this project's chat as model history (pure). */
export function chatHistory(chat: ChatMsg[]): ChatMessage[] {
  return chat
    .filter((m) => !m.streaming && m.text.trim())
    .slice(-HISTORY_TURNS)
    .map((m) => ({ role: m.role === "nic" ? "user" : "assistant", content: m.text }));
}

export function directorRequest(text: string, history: ChatMessage[], context: string, streamId: string): DirectorTurnRequest {
  return { text, history: history.map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content })), context, streamId };
}

const st = () => useDirector.getState();
const patchMsg = (id: string, p: Partial<ChatMsg>) => useDirector.setState((s) => ({ chat: s.chat.map((m) => (m.id === id ? { ...m, ...p } : m)) }));
const log = (slug: string, role: ChatMsg["role"], text: string) => void api.chatLog({ slug, append: { role, text } }).catch(() => undefined);

export interface TurnOptions {
  /** Apply only these action types from the reply (an automatic turn); the rest are listed as ignored. */
  only?: DirectorAction["type"][];
}

/** Split a reply's actions by an allowlist (pure): the rest become "not applied" errors. */
export function allowActions(actions: DirectorAction[], only?: DirectorAction["type"][]): { actions: DirectorAction[]; refused: string[] } {
  if (!only) return { actions, refused: [] };
  return {
    actions: actions.filter((a) => only.includes(a.type)),
    refused: actions.filter((a) => !only.includes(a.type)).map((a) => `${a.type}: not applied on an automatic turn (ask for it yourself if you want it)`),
  };
}

/** Send one line to the Director for the open project. Resolves when the reply has landed: true if
 * the turn was sent, false if it wasn't (empty, no project, or another turn already running). */
export async function sendDirectorTurn(text: string, opts: TurnOptions = {}): Promise<boolean> {
  const body = text.trim();
  const { slug, project, assets, manifest, chat, chatBusy, review } = st();
  if (!body || !slug || !project || !manifest || chatBusy) return false;

  const history = chatHistory(chat);
  const now = new Date().toISOString();
  const userMsg: ChatMsg = { id: crypto.randomUUID(), role: "nic", text: body, at: now };
  const streamId = crypto.randomUUID();
  const replyId = `r-${streamId}`;
  useDirector.setState((s) => ({ chat: [...s.chat, userMsg, { id: replyId, role: "director", text: "", at: now, streaming: true }], chatBusy: true }));
  log(slug, "nic", body);

  let buffered = "";
  const off = await onNativeEvent<{ streamId: string; delta: string; agent?: string }>("tony-token", (e) => {
    if (e.streamId !== streamId) return;
    buffered += e.delta;
    // Hide action blocks while they stream in: show the prose only.
    const cut = buffered.indexOf("```director-action");
    patchMsg(replyId, { text: cut >= 0 ? buffered.slice(0, cut).trimEnd() : buffered });
  });

  const req = directorRequest(body, history, buildDirectorContext(project, assets, manifest, review), streamId);
  try {
    const r = await api.turn({ req });
    const answer = (r.answer || buffered).trim();
    if (!answer) {
      patchMsg(replyId, { text: "(no reply)", streaming: false });
      return true;
    }
    if (st().slug !== slug) return true;
    const parsed = parseDirectorActions(answer, { assets: st().assets, manifest: st().manifest });
    const { actions, refused } = allowActions(parsed.actions, opts.only);
    const errors = [...parsed.errors, ...refused];
    patchMsg(replyId, { text: parsed.prose || "(actions only)", streaming: false, errors: errors.length ? errors : undefined });
    log(slug, "director", answer);
    if (actions.length) {
      const undoBefore = st().undo;
      const applied = await applyDirectorActions(actions, slug);
      const undo = st().undo;
      patchMsg(replyId, { applied, ...(undo && undo !== undoBefore ? { undoId: undo.id } : {}) });
    }
  } catch (e) {
    patchMsg(replyId, { text: `The Director couldn't answer: ${e instanceof Error ? e.message : String(e)}`, streaming: false, errors: undefined });
  } finally {
    off();
    useDirector.setState({ chatBusy: false });
  }
  return true;
}
