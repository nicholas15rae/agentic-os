/**
 * Tony's dispatch packet — the TS mirror of `src-tauri/src/commands/tony_dispatch.rs` (Nic's
 * `TonyDispatch` / `TaskPacket` schema). Rust is authoritative (it validates and routes); the
 * webview needs the types, the same validation for tests / previews, and `spokenSoFar`, which
 * pulls `spoken_reply` out of a half-streamed packet so TTS starts at the first sentence.
 */

export const AGENT_ROLES = ["librarian", "prompter", "coder", "designer", "director", "financer", "observer", "security"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export const PRIORITIES = ["low", "normal", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface TaskPacket {
  task_id: string;
  target_agent: AgentRole;
  action: string;
  inputs: string[];
  constraints: string[];
  acceptance_criteria: string[];
  depends_on: string[];
}

export interface TonyDispatch {
  spoken_reply: string;
  requires_dispatch: boolean;
  priority: Priority;
  tasks: TaskPacket[];
}

const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The same rules as Rust `tony_dispatch::validate` (null = valid). */
export function validatePacket(raw: unknown): { ok: true; value: TonyDispatch } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!raw || typeof raw !== "object") return bad("not an object");
  const o = raw as Record<string, unknown>;
  if (typeof o.spoken_reply !== "string" || !o.spoken_reply.trim()) return bad("spoken_reply is empty");
  if (typeof o.requires_dispatch !== "boolean") return bad("requires_dispatch must be true or false");
  const priority = (o.priority ?? "normal") as Priority;
  if (!PRIORITIES.includes(priority)) return bad(`priority must be one of ${PRIORITIES.join(", ")}`);
  const rawTasks = o.tasks ?? [];
  if (!Array.isArray(rawTasks)) return bad("tasks must be a list");
  const ids = new Set<string>();
  const tasks: TaskPacket[] = [];
  for (const t of rawTasks as Record<string, unknown>[]) {
    const id = typeof t?.task_id === "string" ? t.task_id.trim() : "";
    if (id.length < 2 || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) return bad(`task_id ${JSON.stringify(id)}: 2-64 letters, digits, _ or -`);
    if (ids.has(id)) return bad(`task_id ${id} is used twice`);
    ids.add(id);
    if (!AGENT_ROLES.includes(t.target_agent as AgentRole)) return bad(`${id}: target_agent ${String(t.target_agent)} is not a known agent`);
    if (typeof t.action !== "string" || t.action.trim().length < 5) return bad(`${id}: action needs at least 5 characters`);
    for (const k of ["inputs", "constraints", "depends_on"] as const) if (t[k] !== undefined && !isStrList(t[k])) return bad(`${id}: ${k} must be a list of strings`);
    if (!isStrList(t.acceptance_criteria) || !t.acceptance_criteria.some((c) => c.trim())) return bad(`${id}: at least one acceptance criterion`);
    tasks.push({ task_id: id, target_agent: t.target_agent as AgentRole, action: t.action.trim(), inputs: (t.inputs as string[]) ?? [], constraints: (t.constraints as string[]) ?? [], acceptance_criteria: t.acceptance_criteria, depends_on: (t.depends_on as string[]) ?? [] });
  }
  for (const t of tasks) for (const d of t.depends_on) if (d === t.task_id || !ids.has(d)) return bad(`${t.task_id}: depends_on ${d} is not another task in this packet`);
  // Cycle check (Kahn).
  const done = new Set<string>();
  while (done.size < tasks.length) {
    const next = tasks.filter((t) => !done.has(t.task_id) && t.depends_on.every((d) => done.has(d)));
    if (!next.length) return bad("depends_on has a cycle");
    for (const t of next) done.add(t.task_id);
  }
  return { ok: true, value: { spoken_reply: o.spoken_reply.trim(), requires_dispatch: o.requires_dispatch && tasks.length > 0, priority, tasks } };
}

/** Does a (possibly partial) reply look like a packet rather than prose? */
export function looksLikePacket(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("{") || /^```(?:json)?\s*\{/i.test(t) || t === "`" || t === "``" || /^```(?:j(?:s(?:o(?:n)?)?)?)?\s*$/i.test(t);
}

/**
 * `spoken_reply` decoded from a partial packet, as far as it has streamed (null: not a packet).
 * A half-received escape at the end is held back, so the text only ever grows.
 */
export function spokenSoFar(text: string): string | null {
  if (!looksLikePacket(text)) return null;
  const m = /"spoken_reply"\s*:\s*"/.exec(text);
  if (!m) return "";
  let i = m.index + m[0].length;
  let out = "";
  while (i < text.length) {
    const c = text[i];
    if (c === '"') break;
    if (c === "\\") {
      const n = text[i + 1];
      if (n === undefined) break;
      if (n === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[n] ?? n;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/^\s+/, "");
}
