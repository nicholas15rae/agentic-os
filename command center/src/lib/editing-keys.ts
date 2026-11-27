/**
 * Native text editing always wins inside a text field. Installed once, first, in the capture
 * phase on window: while an <input>, <textarea> or contenteditable has focus, the editing
 * shortcuts (select all, copy, cut, paste, undo, redo, word delete / move) stop here, so no
 * app-wide keydown listener (page switching, panels, hotkeys) can act on them or call
 * preventDefault. The browser's own default action still runs; nothing is prevented here.
 */

const EDIT_KEYS = new Set(["a", "c", "v", "x", "z", "y", "backspace", "delete", "arrowleft", "arrowright", "arrowup", "arrowdown", "home", "end"]);
const TEXT_INPUTS = /^(text|search|url|email|tel|password|number)$/;

export function isTextField(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: boolean; type?: string } | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && TEXT_INPUTS.test(el.type || "text");
}

/** True when `e` is a text-editing shortcut aimed at a focused text field (pure). */
export function isEditingShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "target">): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  return EDIT_KEYS.has(e.key.toLowerCase()) && isTextField(e.target);
}

let installed = false;

export function installEditingKeyGuard() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(
    "keydown",
    (e) => {
      if (isEditingShortcut(e)) e.stopImmediatePropagation();
    },
    true,
  );
}
