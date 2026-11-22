import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Prompt drafts and history for the multiline prompt boxes (Steer, Re-queue note, Tweak, Tony
 * chat). Unsent text is kept per box in localStorage, so switching views, pausing or restarting
 * never loses a long master prompt. Every read and write is guarded: a blocked or full storage
 * only means no draft, never a broken box.
 */

const DRAFT = "cc.draft.";
const HISTORY = "cc.prompt-history.";
export const HISTORY_MAX = 20;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked or full: the box still works, the draft just isn't kept.
  }
}

/** The draft saved for `key` ("" when none). */
export function loadDraft(key: string): string {
  return read(DRAFT + key) ?? "";
}

/**
 * Live drafts, by key, outside any component: a card that re-renders or re-mounts on a hub /
 * telemetry tick (or a section re-mount) reads its text back from here synchronously, so a tick
 * can never wipe or clip what is being typed or pasted.
 */
const live = new Map<string, string>();

/**
 * `useState` for a prompt box that survives re-mounts, navigation and restarts. The in-memory copy
 * updates on every change; the localStorage copy is debounced (a 100k-character paste shouldn't
 * be re-serialised on every keystroke) and flushed on unmount. `key` null: plain state.
 */
export function useDraft(key: string | null): [string, (v: string | ((cur: string) => string)) => void] {
  const [value, setValue] = useState(() => (key ? (live.get(key) ?? loadDraft(key)) : ""));
  const latest = useRef(value);
  latest.current = value;
  if (key) live.set(key, value);
  useEffect(() => {
    if (!key) return;
    const t = setTimeout(() => write(DRAFT + key, latest.current.trim() ? latest.current : null), 300);
    return () => clearTimeout(t);
  }, [key, value]);
  useEffect(() => {
    if (!key) return;
    return () => write(DRAFT + key, latest.current.trim() ? latest.current : null);
  }, [key]);
  const set = useCallback(
    (v: string | ((cur: string) => string)) =>
      setValue((cur) => {
        const next = typeof v === "function" ? v(cur) : v;
        if (key) live.set(key, next);
        return next;
      }),
    [key],
  );
  return [value, set];
}

/** Sent prompts for a history scope, newest first. */
export function loadHistory(scope: string): string[] {
  try {
    const v = JSON.parse(read(HISTORY + scope) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Remember a sent prompt (deduplicated, newest first, at most HISTORY_MAX). Pure on `list`. */
export function withHistory(list: string[], text: string): string[] {
  const t = text.trim();
  if (!t) return list;
  return [t, ...list.filter((x) => x !== t)].slice(0, HISTORY_MAX);
}

export function pushHistory(scope: string, text: string): string[] {
  const next = withHistory(loadHistory(scope), text);
  write(HISTORY + scope, JSON.stringify(next));
  return next;
}

export function clearHistory(scope: string) {
  write(HISTORY + scope, null);
}

/** A rough token estimate (≈4 characters per token for English prose and code). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** "12,345 chars · ~3.1k tokens". */
export function countLabel(text: string): string {
  const n = text.length;
  const t = estimateTokens(text);
  const tk = t >= 1000 ? `${(t / 1000).toFixed(t >= 10_000 ? 0 : 1)}k` : String(t);
  return `${n.toLocaleString()} chars · ~${tk} tokens`;
}

/** Files a prompt box accepts on drop. */
export const isPromptFile = (f: { name: string; type?: string }) => /\.(md|markdown|txt)$/i.test(f.name) || f.type === "text/plain" || f.type === "text/markdown";

/**
 * Insert `text` at the caret (or replace everything) through the browser's own editing command,
 * so Ctrl+Z / Ctrl+Y undo and redo it like a typed edit. Falls back to `fallback` (a plain state
 * set) where `insertText` is unavailable.
 */
export function insertText(el: HTMLTextAreaElement | null, text: string, opts: { replaceAll?: boolean; fallback: (next: string) => void }) {
  if (!el) return opts.fallback(text);
  el.focus();
  if (opts.replaceAll) el.select();
  let ok = false;
  try {
    ok = text ? document.execCommand("insertText", false, text) : document.execCommand("delete");
  } catch {
    ok = false;
  }
  if (!ok) {
    const start = opts.replaceAll ? 0 : el.selectionStart;
    const end = opts.replaceAll ? el.value.length : el.selectionEnd;
    opts.fallback(el.value.slice(0, start) + text + el.value.slice(end));
  }
}
