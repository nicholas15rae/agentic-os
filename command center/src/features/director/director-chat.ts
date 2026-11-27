/**
 * Director chat: one typed turn to the Director's own `director_turn` command (director.rs): the
 * Director persona + craft guide, this project's context and history, on the local chat chain.
 * OUTSIDE Tony's voice pipeline and routing (no voice store, no TTS, nothing in Tony's thread, no
 * Tony persona). `tony-token` deltas for this turn's own stream id stream into this page's bubble;
 * each message is appended to the project's chat log (media_chat_log). Action blocks in the reply
 * only fill the UI.
 *
 * One automatic corrective turn (E2E fix 4): when a reply's action blocks don't validate, or its
 * plan is refused by media_plan_check, or its revision changes nothing, the page sends ONE
 * "[auto-fix]" follow-up quoting the exact errors. Its reply follows the same rules as the turn it
 * fixes (an automatic turn's fix still only suggests), and it never retries again.
 */
import { onNativeEvent, type ChatMessage } from "@/lib/platform";
import { api } from "./api";
import type { AssetTranscriptLines, DirectorAction, DirectorTurnRequest } from "./contract";
import { extractActionBlocks, parseDirectorActions } from "./actions";
import { buildDirectorContext } from "./context";
import { applyDirectorActionsReport, AUTO_FIX_SHOWN, AUTO_FIX_TAG, isAutoFixLine, setBriefIdea, useDirector, type ChatMsg } from "./director-store";

export const HISTORY_TURNS = 10;
/** How a page-sent auto-fix line reads in model history: it is the app speaking, not Nic. */
export const AUTO_FIX_HISTORY_LABEL = "(sent by the app, not Nic)";

/** The last ~10 turns of this project's chat as model history (pure). An auto-fix line (live, or
 * restored from the log) is labelled as the app's, never passed off as Nic's words. */
export function chatHistory(chat: ChatMsg[]): ChatMessage[] {
  return chat
    .filter((m) => !m.streaming && m.text.trim())
    .slice(-HISTORY_TURNS)
    .map((m) => ({ role: m.role === "nic" ? "user" : "assistant", content: m.autoFix || isAutoFixLine(m.role, m.text) ? `${AUTO_FIX_HISTORY_LABEL} ${m.text}` : m.text }));
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
  /** Nic's own words behind this turn (a first brief keeps its idea from them). Defaults to the sent
   * line on a turn Nic typed; an automatic turn has none. */
  nicLine?: string;
  /** Nic's idea from the BriefCard textarea: recorded so the drafted brief keeps it word for word. */
  briefIdea?: string;
}

/** Split a reply's actions by an allowlist (pure): the rest become "not applied" errors. */
export function allowActions(actions: DirectorAction[], only?: DirectorAction["type"][]): { actions: DirectorAction[]; refused: string[] } {
  if (!only) return { actions, refused: [] };
  return {
    actions: actions.filter((a) => only.includes(a.type)),
    refused: actions.filter((a) => !only.includes(a.type)).map((a) => `${a.type}: not applied on an automatic turn (ask for it yourself if you want it)`),
  };
}

// ── The one automatic corrective turn ────────────────────────────────────────

export { AUTO_FIX_TAG };
const ACTION_TYPES: DirectorAction["type"][] = ["draft_brief", "populate_shot_list", "match_footage", "propose_edit_plan", "revise_edit", "report_open_decisions", "execute_verified_render"];
const MAX_QUOTED_BLOCKS = 4000;

/** The action type a raw block names, if it names a known one (pure). */
export function blockType(raw: string): DirectorAction["type"] | null {
  const m = /"type"\s*:\s*"([a-z_]+)"/.exec(raw);
  return m && (ACTION_TYPES as string[]).includes(m[1]) ? (m[1] as DirectorAction["type"]) : null;
}

/** What one reply got wrong, for the auto-fix turn. */
export interface TurnProblems {
  problems: string[];
  /** The failed blocks' raw JSON (as the Director sent them). */
  blocks: string[];
  /** Their action types; null when one of them can't be told (broken JSON with no "type"). */
  types: DirectorAction["type"][] | null;
}

/** The problems in a reply (pure): validation errors (not the automatic-turn allowlist) plus the
 * apply step's refusals. */
export function turnProblems(answer: string, parseErrors: string[], refusals: string[], refusedTypes: DirectorAction["type"][]): TurnProblems {
  const raw = extractActionBlocks(answer);
  const problems: string[] = [];
  const blocks: string[] = [];
  let types: DirectorAction["type"][] | null = [];
  for (const e of parseErrors) {
    problems.push(e);
    const n = /^block (\d+):/.exec(e);
    const b = n ? raw[Number(n[1]) - 1] : undefined;
    if (b !== undefined) blocks.push(b);
    const t = b !== undefined ? blockType(b) : null;
    if (t && types) types.push(t);
    else types = null;
  }
  for (const r of refusals) problems.push(r);
  for (const t of refusedTypes) {
    if (types) types.push(t);
    for (const b of raw) if (blockType(b) === t && !blocks.includes(b)) blocks.push(b);
  }
  return { problems, blocks, types: types ? [...new Set(types)] : null };
}

/** The action types the fix may apply (pure): only the ones that failed, within the original turn's
 * allowlist. `false` = nothing the fix could apply, so there's no fix turn. */
export function fixAllowlist(types: DirectorAction["type"][] | null, only?: DirectorAction["type"][]): DirectorAction["type"][] | undefined | false {
  if (!types) return only;
  const allowed = only ? types.filter((t) => only.includes(t)) : types;
  return allowed.length ? allowed : false;
}

/** The auto-fix line the Director gets (pure). */
export function autoFixPrompt(p: Pick<TurnProblems, "problems" | "blocks">): string {
  let quoted = "";
  for (const b of p.blocks) {
    if (quoted.length + b.length > MAX_QUOTED_BLOCKS) break;
    quoted += `${b}\n`;
  }
  return [
    `${AUTO_FIX_TAG} The app couldn't use part of your last reply:`,
    ...p.problems.map((x) => `- ${x}`),
    quoted ? `Those blocks as you sent them:\n${quoted.trimEnd()}` : "",
    "Send corrected director-action blocks for exactly those (same JSON shapes, fixing only what's listed). Blocks that already applied don't need repeating. Everything stays a suggestion until Nic clicks.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The short "[auto-fix]" line the chat shows and logs (pure). */
export function autoFixLine(problems: string[]): string {
  return `${AUTO_FIX_SHOWN} ${problems.join(" | ")}`;
}

// ── Turns ────────────────────────────────────────────────────────────────────

interface RunOpts {
  only?: DirectorAction["type"][];
  nicLine?: string;
  /** An auto-fix turn: `body` goes to the model, `shown` to the chat and its log. */
  autoFix?: { shown: string };
}

type TranscriptLinesFn = (a: { slug: string }) => Promise<AssetTranscriptLines[]>;

/** The project's timed transcript lines for the TRANSCRIPT section (media_transcript_lines; Rust
 * reads the files and caches them by mtime). Empty when the backend has no such command (an older
 * build, a test double) or the read fails: the turn goes on without the section. */
export async function transcriptLinesFor(slug: string): Promise<AssetTranscriptLines[]> {
  const fn = (api as { transcriptLines?: TranscriptLinesFn }).transcriptLines;
  if (typeof fn !== "function") return [];
  try {
    const r = await fn({ slug });
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

/** One model call + apply, with chatBusy already held by the caller. Null = no reply to judge. */
async function runTurn(slug: string, body: string, opts: RunOpts): Promise<(TurnProblems & { replyId: string }) | null> {
  const transcripts = await transcriptLinesFor(slug);
  const { project, assets, manifest, chat, review } = st();
  if (st().slug !== slug || !project || !manifest) return null;
  const history = chatHistory(chat);
  const now = new Date().toISOString();
  const shown = opts.autoFix?.shown ?? body;
  const userMsg: ChatMsg = { id: crypto.randomUUID(), role: "nic", text: shown, at: now, ...(opts.autoFix ? { autoFix: true } : {}) };
  const streamId = crypto.randomUUID();
  const replyId = `r-${streamId}`;
  useDirector.setState((s) => ({ chat: [...s.chat, userMsg, { id: replyId, role: "director", text: "", at: now, streaming: true }] }));
  log(slug, "nic", shown);

  let buffered = "";
  const off = await onNativeEvent<{ streamId: string; delta: string; agent?: string }>("tony-token", (e) => {
    if (e.streamId !== streamId) return;
    buffered += e.delta;
    // Hide action blocks while they stream in: show the prose only.
    const cut = buffered.indexOf("```director-action");
    patchMsg(replyId, { text: cut >= 0 ? buffered.slice(0, cut).trimEnd() : buffered });
  });

  const req = directorRequest(body, history, buildDirectorContext(project, assets, manifest, review, transcripts), streamId);
  try {
    const r = await api.turn({ req });
    const answer = (r.answer || buffered).trim();
    if (!answer) {
      patchMsg(replyId, { text: "(no reply)", streaming: false });
      return null;
    }
    if (st().slug !== slug) return null;
    const parsed = parseDirectorActions(answer, { assets: st().assets, manifest: st().manifest });
    const { actions, refused } = allowActions(parsed.actions, opts.only);
    const errors = [...parsed.errors, ...refused];
    patchMsg(replyId, { text: parsed.prose || "(actions only)", streaming: false, errors: errors.length ? errors : undefined });
    log(slug, "director", answer);
    let report = { notes: [] as string[], warnings: [] as string[], refusals: [] as string[], refusedTypes: [] as DirectorAction["type"][] };
    if (actions.length) {
      const undoBefore = st().undo;
      report = await applyDirectorActionsReport(actions, slug, { nicLine: opts.nicLine });
      const undo = st().undo;
      patchMsg(replyId, { applied: report.notes, ...(report.warnings.length ? { warnings: report.warnings } : {}), ...(undo && undo !== undoBefore ? { undoId: undo.id } : {}) });
    }
    return { replyId, ...turnProblems(answer, parsed.errors, report.refusals, report.refusedTypes) };
  } catch (e) {
    patchMsg(replyId, { text: `The Director couldn't answer: ${e instanceof Error ? e.message : String(e)}`, streaming: false, errors: undefined });
    return null;
  } finally {
    off();
  }
}

/** Send one line to the Director for the open project. Resolves when the reply (and its one
 * auto-fix, if it needed one) has landed: true if the turn was sent, false if it wasn't (empty, no
 * project, or another turn already running). */
export async function sendDirectorTurn(text: string, opts: TurnOptions = {}): Promise<boolean> {
  const body = text.trim();
  const { slug, project, manifest, chatBusy } = st();
  if (!body || !slug || !project || !manifest || chatBusy) return false;
  // Taken synchronously, before any await: no other turn (or retry) can start until it's released.
  useDirector.setState({ chatBusy: true });
  // The BriefCard idea is for this turn (and its fix) only: a later chat turn must not inherit it.
  const recordedIdea = !!opts.briefIdea?.trim() && !project.brief;
  try {
    if (recordedIdea) setBriefIdea(opts.briefIdea ?? null);
    const nicLine = opts.nicLine ?? (opts.only ? undefined : body);
    const first = await runTurn(slug, body, { only: opts.only, nicLine });
    if (!first || !first.problems.length || st().slug !== slug) return true;
    // Store-level guard: one auto-fix per original reply, ever.
    if (st().autoFixed.includes(first.replyId)) return true;
    const only = fixAllowlist(first.types, opts.only);
    if (only === false) return true;
    useDirector.setState((s) => ({ autoFixed: [...s.autoFixed.slice(-49), first.replyId] }));
    await runTurn(slug, autoFixPrompt(first), { only, nicLine, autoFix: { shown: autoFixLine(first.problems) } });
  } finally {
    if (recordedIdea && st().slug === slug) setBriefIdea(null);
    useDirector.setState({ chatBusy: false });
  }
  return true;
}
