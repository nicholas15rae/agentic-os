/**
 * Part 6 phone-friendly shot list: the plain-text copy for notes / WhatsApp (pure) and the
 * clipboard write. Clipboard only: nothing is sent anywhere.
 */
import type { ShotSlot } from "./contract";

const FRAMING_LABEL: Record<NonNullable<ShotSlot["framing"]>, string> = { wide: "Wide", medium: "Medium", mcu: "Medium close-up", closeup: "Close-up", insert: "Insert", overhead: "Overhead", pov: "POV" };
export const framingLabel = (f: ShotSlot["framing"]) => (f ? FRAMING_LABEL[f] : "");

/** The shot list as plain text, one block per slot: "[ ] 1. Hook (Close-up, 3s)", then what to
 * do, then "- tip" lines. Filmed shots are "[x]". Pure. */
export function shotListText(title: string, slots: ShotSlot[]): string {
  const done = slots.filter((s) => s.filmed).length;
  const head = `Shot list: ${title.trim() || "Untitled"} (${done} of ${slots.length} filmed)`;
  const blocks = slots.map((s, i) => {
    const meta = [framingLabel(s.framing), s.targetSec != null ? `${s.targetSec}s` : ""].filter(Boolean).join(", ");
    const lines = [`[${s.filmed ? "x" : " "}] ${i + 1}. ${s.label}${meta ? ` (${meta})` : ""}`];
    const what = (s.action || s.instructions).trim();
    if (what) lines.push(`    ${what}`);
    if (s.action && s.instructions.trim()) lines.push(`    ${s.instructions.trim()}`);
    for (const t of s.phoneTips) lines.push(`    - ${t}`);
    return lines.join("\n");
  });
  return [head, ...blocks].join("\n\n");
}

/** Copy to the clipboard. False when the browser refuses (no permission, no clipboard). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
