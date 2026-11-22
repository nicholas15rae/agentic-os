import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ClipboardPaste, Eraser, FileUp, History, Loader2, Maximize2, Send, X } from "lucide-react";
import { useToasts } from "@/features/reminders/notify";
import { clearHistory, countLabel, insertText, isPromptFile, loadHistory, pushHistory } from "@/lib/prompt-drafts";

export interface PromptBoxProps {
  value: string;
  onChange: (v: string) => void;
  /** Ctrl+Enter or the send button, with the trimmed text. Never called with "". */
  onSubmit: (text: string) => void | Promise<unknown>;
  /** Aria label, and the expanded editor's title. */
  label: string;
  placeholder?: string;
  submitLabel?: string;
  submitIcon?: ReactNode;
  /** A send is in flight: the button spins and Ctrl+Enter waits. */
  busy?: boolean;
  disabled?: boolean;
  /** Allow sending an empty box (an optional note). */
  allowEmpty?: boolean;
  /** Remember sent prompts under this scope and offer them from the history menu. */
  historyKey?: string;
  /** Extra controls on the toolbar, left of the counter (a target picker, Max Iterations…). */
  adornment?: ReactNode;
  /** Height the box grows to before it scrolls inside. */
  maxHeight?: number;
  autoFocus?: boolean;
  size?: "sm" | "md";
  submitTitle?: string;
}

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/**
 * The multiline prompt box: grows with its text up to `maxHeight`, then scrolls; Enter is a new
 * line and Ctrl+Enter sends; no character cap. Corner tools: history, paste, clear, a full-size
 * editor (⤢) and a live character / token count. Drop a .md / .txt file on it to load the file.
 * Programmatic edits go through the browser's editing command, so Ctrl+Z undoes them too.
 */
export function PromptBox(p: PromptBoxProps) {
  const { value, onChange, label, busy = false, disabled = false, maxHeight = 200, size = "sm" } = p;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [drag, setDrag] = useState(false);
  const sendable = !busy && !disabled && (p.allowEmpty || !!value.trim());

  useLayoutEffect(() => fit(ref.current, maxHeight), [value, maxHeight]);

  const submit = () => {
    if (!sendable) return;
    const text = value.trim();
    if (p.historyKey && text) pushHistory(p.historyKey, text);
    void p.onSubmit(text);
  };

  const text = size === "md" ? "text-sm" : "text-[12px]";
  return (
    <div
      className={`relative w-full rounded-[12px] border bg-well transition-[border-color,box-shadow] duration-150 focus-within:border-teal focus-within:shadow-[0_0_12px_rgba(0,229,195,0.25)] ${drag ? "border-amber/70 bg-amber/[0.06]" : "border-white/[0.08]"}`}
      {...dropHandlers(setDrag, (t) => insertText(ref.current, t, { fallback: onChange }))}
    >
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => onEditorKey(e, submit, () => setExpanded(true))}
        placeholder={p.placeholder}
        aria-label={label}
        disabled={disabled}
        autoFocus={p.autoFocus}
        spellCheck
        className={`block w-full resize-none bg-transparent px-3 pt-2 pb-1 leading-relaxed text-ink outline-none placeholder:text-ink-3 ${text}`}
        style={{ maxHeight }}
      />
      <div className="flex flex-wrap items-center gap-1 px-1.5 pb-1.5">
        {p.adornment}
        <Tools label={label} value={value} historyKey={p.historyKey} editor={ref} onChange={onChange} onExpand={() => setExpanded(true)} />
        <span className={`ml-auto truncate pl-1 font-mono text-[10px] ${value ? "text-ink-2" : "text-ink-3"}`} aria-live="polite" title="Exactly what will be sent">
          {value ? countLabel(value) : "0 chars"}
        </span>
        <span className="hidden font-mono text-[10px] text-ink-3 md:inline">· {MOD}+Enter to send</span>
        <button type="button" onClick={submit} disabled={!sendable} title={p.submitTitle ?? `${p.submitLabel ?? "Send"} (${MOD}+Enter)`} className="pill-glass ml-1 !h-7 shrink-0 !px-2.5 text-[11px] disabled:opacity-50">
          {busy ? <Loader2 size={11} className="animate-spin" /> : (p.submitIcon ?? <Send size={11} />)} {p.submitLabel ?? "Send"}
        </button>
      </div>
      {expanded && (
        <ExpandedEditor
          {...p}
          sendable={sendable}
          onClose={() => {
            setExpanded(false);
            requestAnimationFrame(() => ref.current?.focus());
          }}
          onSend={() => {
            submit();
            setExpanded(false);
          }}
        />
      )}
    </div>
  );
}

/** Grow `el` to its content, up to `max`, then scroll inside. */
function fit(el: HTMLTextAreaElement | null, max: number) {
  if (!el) return;
  el.style.height = "auto";
  const h = Math.min(el.scrollHeight + 2, max);
  el.style.height = `${h}px`;
  el.style.overflowY = el.scrollHeight + 2 > max ? "auto" : "hidden";
}

/** Ctrl/⌘+Enter sends; Ctrl+Shift+E opens the big editor. Everything else (Ctrl+A/C/V/X/Z/Y, plain
 * Enter for a new line) stays the browser's own, and never reaches an app-wide shortcut. */
function onEditorKey(e: React.KeyboardEvent<HTMLTextAreaElement>, submit: () => void, expand?: () => void) {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === "Enter") {
    e.preventDefault();
    submit();
    return;
  }
  if (expand && mod && e.shiftKey && e.key.toLowerCase() === "e") {
    e.preventDefault();
    expand();
    return;
  }
  if (mod) e.stopPropagation();
}

function dropHandlers(setDrag: (v: boolean) => void, insert: (text: string) => void) {
  const files = (e: React.DragEvent) => Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file");
  return {
    onDragOver: (e: React.DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      e.stopPropagation(); // the full-size editor is portalled inside the small box
      e.dataTransfer.dropEffect = "copy";
      setDrag(true);
    },
    onDragLeave: () => setDrag(false),
    onDrop: (e: React.DragEvent) => {
      const list = Array.from(e.dataTransfer?.files ?? []);
      if (!list.length) return;
      e.preventDefault();
      e.stopPropagation();
      setDrag(false);
      const ok = list.filter(isPromptFile);
      if (!ok.length) {
        useToasts.getState().push({ title: "Not a text file", body: "Drop a .md or .txt file to load its text.", tone: "error" });
        return;
      }
      void Promise.all(ok.map((f) => f.text())).then((texts) => insert(texts.join("\n\n")));
    },
  };
}

function Tools({ label, value, historyKey, editor, onChange, onExpand, big = false }: { label: string; value: string; historyKey?: string; editor: React.RefObject<HTMLTextAreaElement | null>; onChange: (v: string) => void; onExpand?: () => void; big?: boolean }) {
  const btn = `grid ${big ? "size-8" : "size-6"} place-items-center rounded-full text-ink-3 transition-colors hover:bg-white/[0.08] hover:text-ink disabled:opacity-40`;
  const icon = big ? 14 : 12;
  const file = useRef<HTMLInputElement>(null);
  const attach = (files: FileList | null) => {
    const list = Array.from(files ?? []).filter(isPromptFile);
    if (!list.length) return;
    void Promise.all(list.map((f) => f.text())).then((texts) => insertText(editor.current, texts.join("\n\n"), { fallback: (next) => onChange(next) }));
  };
  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) insertText(editor.current, t, { fallback: onChange });
    } catch {
      editor.current?.focus();
      useToasts.getState().push({ title: "Clipboard blocked", body: `Press ${MOD}+V in the box instead.`, tone: "info" });
    }
  };
  return (
    <div className="flex items-center gap-0.5">
      {historyKey && <HistoryMenu scope={historyKey} className={btn} size={icon} onPick={(t) => insertText(editor.current, t, { replaceAll: true, fallback: onChange })} />}
      <button type="button" onClick={() => void paste()} className={btn} title="Paste from the clipboard" aria-label={`Paste into ${label}`}>
        <ClipboardPaste size={icon} />
      </button>
      <button type="button" onClick={() => file.current?.click()} className={btn} title="Attach a .md / .txt file (or drop it on the box)" aria-label={`Attach a text file to ${label}`}>
        <FileUp size={icon} />
      </button>
      <input
        ref={file}
        type="file"
        accept=".md,.markdown,.txt,text/plain,text/markdown"
        multiple
        hidden
        onChange={(e) => {
          attach(e.target.files);
          e.target.value = "";
        }}
      />
      <button type="button" onClick={() => insertText(editor.current, "", { replaceAll: true, fallback: onChange })} disabled={!value} className={btn} title={`Clear (${MOD}+Z brings it back)`} aria-label={`Clear ${label}`}>
        <Eraser size={icon} />
      </button>
      {onExpand && (
        <button type="button" onClick={onExpand} className={btn} title={`Open the full-size editor (${MOD}+Shift+E)`} aria-label={`Expand ${label}`}>
          <Maximize2 size={icon} />
        </button>
      )}
    </div>
  );
}

function HistoryMenu({ scope, className, size, onPick }: { scope: string; className: string; size: number; onPick: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setOpen(false));
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => {
          setItems(loadHistory(scope));
          setOpen((o) => !o);
        }}
        className={className}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Recent prompts"
        aria-label="Recent prompts"
      >
        <History size={size} />
      </button>
      {open && (
        <div role="menu" className="glass absolute bottom-full left-0 z-30 mb-1 w-[min(420px,80vw)] rounded-[12px] p-1.5 shadow-xl">
          {!items.length ? (
            <p className="px-2 py-1.5 text-[11px] text-ink-3">Nothing sent from here yet.</p>
          ) : (
            <>
              <ul className="max-h-64 overflow-y-auto">
                {items.map((t, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onPick(t);
                        setOpen(false);
                      }}
                      className="block w-full rounded-[8px] px-2 py-1.5 text-left text-[11px] text-ink-2 hover:bg-white/[0.06] hover:text-ink"
                      title="Load into the box to tweak and re-send"
                    >
                      <span className="line-clamp-2 whitespace-pre-wrap break-words">{t}</span>
                      <span className="font-mono text-[9.5px] text-ink-3">{t.length.toLocaleString()} chars</span>
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => {
                  clearHistory(scope);
                  setItems([]);
                }}
                className="mt-1 w-full rounded-[8px] px-2 py-1 text-left font-mono text-[10px] text-ink-3 hover:text-alert"
              >
                Clear history
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ExpandedEditor(p: PromptBoxProps & { sendable: boolean; onClose: () => void; onSend: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [drag, setDrag] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return createPortal(
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/70 p-3"
      role="dialog"
      aria-modal="true"
      aria-label={`${p.label}: full-size editor`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          p.onClose();
        }
      }}
      onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}
    >
      <div className="glass flex h-[88dvh] w-[min(1100px,96vw)] flex-col rounded-[20px] p-4">
        <div className="mb-2 flex items-center gap-2">
          <Maximize2 size={14} className="text-amber-soft" />
          <h2 className="truncate text-[15px] font-semibold text-ink">{p.label}</h2>
          <span className="ml-auto font-mono text-[11px] text-ink-3">{countLabel(p.value)}</span>
          <button type="button" onClick={p.onClose} className="pill-glass !h-8 !w-8 !p-0" aria-label="Close the editor (the text is kept)" title="Close (Esc) — the text is kept">
            <X size={14} />
          </button>
        </div>
        <div className={`min-h-0 flex-1 rounded-[12px] border bg-well ${drag ? "border-amber/70" : "border-white/[0.08] focus-within:border-teal"}`} {...dropHandlers(setDrag, (t) => insertText(ref.current, t, { fallback: p.onChange }))}>
          <textarea
            ref={ref}
            value={p.value}
            onChange={(e) => p.onChange(e.target.value)}
            onKeyDown={(e) => onEditorKey(e, p.onSend)}
            placeholder={p.placeholder}
            aria-label={`${p.label} (full-size)`}
            spellCheck
            className="size-full resize-none overflow-y-auto bg-transparent p-4 font-mono text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-3"
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Tools big label={p.label} value={p.value} historyKey={p.historyKey} editor={ref} onChange={p.onChange} />
          {p.adornment}
          <span className="ml-auto font-mono text-[11px] text-ink-3">Enter = new line · {MOD}+Enter to send · Esc closes (text kept)</span>
          <button type="button" onClick={p.onSend} disabled={!p.sendable} className="pill-primary !h-9 text-xs disabled:opacity-50">
            {p.busy ? <Loader2 size={13} className="animate-spin" /> : (p.submitIcon ?? <Send size={13} />)} {p.submitLabel ?? "Send"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
