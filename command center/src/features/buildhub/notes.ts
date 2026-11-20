import type { Item } from "@/lib/cc-api";
import type { BrainstormNote } from "@/features/brainstorm/capture";
import { clipMarked, NOTE_MAX, type IntakeNote } from "./compile";

/** The organized summary's share of a note (the raw words get the rest). */
const SUMMARY_SHARE = 400;

/**
 * A brainstorm note as the Prompter / compiler read it: a short organized summary, then Nic's
 * RAW words (what the card promises is "kept exactly as captured"), then the organized
 * categories / actions with whatever room is left. Every cut is marked. (The organized text used
 * to go first and the transcript was what got cut, silently.) Pure.
 */
export function noteToIntake(n: Item<BrainstormNote>): IntakeNote {
  const o = n.organized;
  const raw = (n.rawText || (n.segments ?? []).map((s) => s.text).join("\n")).trim();
  const head = o?.summary ? clipMarked(`Summary: ${o.summary}`, SUMMARY_SHARE) : "";
  const extras = [...(o?.categories ?? []).map((c) => `${c.name}: ${c.bullets.join("; ")}`), ...(o?.actions?.length ? [`Actions: ${o.actions.map((a) => a.text).join("; ")}`] : [])].join("\n");
  const rawRoom = NOTE_MAX - head.length - (extras ? Math.min(extras.length, 300) : 0) - 8;
  const rawPart = raw ? clipMarked(o ? `Raw: ${raw}` : raw, Math.max(400, rawRoom)) : "";
  const parts = [head, rawPart].filter(Boolean);
  const used = parts.join("\n").length;
  if (extras && used + 1 < NOTE_MAX) parts.push(clipMarked(extras, NOTE_MAX - used - 1));
  return { id: n.id, title: n.title || "Untitled brainstorm", text: parts.join("\n").slice(0, NOTE_MAX), created: n._created ?? 0 };
}
