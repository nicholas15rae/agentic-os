import type { Item } from "@/lib/cc-api";
import type { BrainstormNote } from "@/features/brainstorm/capture";
import { NOTE_MAX, type IntakeNote } from "./compile";

/** A brainstorm note as the Prompter / compiler read it: organized summary + bullets + actions, then the raw transcript. Pure. */
export function noteToIntake(n: Item<BrainstormNote>): IntakeNote {
  const o = n.organized;
  const parts: string[] = [];
  if (o?.summary) parts.push(o.summary);
  for (const c of o?.categories ?? []) parts.push(`${c.name}: ${c.bullets.join("; ")}`);
  if (o?.actions?.length) parts.push(`Actions: ${o.actions.map((a) => a.text).join("; ")}`);
  const raw = (n.rawText || (n.segments ?? []).map((s) => s.text).join("\n")).trim();
  if (raw) parts.push(o ? `Raw: ${raw}` : raw);
  return { id: n.id, title: n.title || "Untitled brainstorm", text: parts.join("\n").slice(0, NOTE_MAX), created: n._created ?? 0 };
}
