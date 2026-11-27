import { useEffect, useRef, useState } from "react";
import { Loader2, Send, TriangleAlert, Undo2 } from "lucide-react";
import { Card, Empty } from "@/components/ui";
import { sendDirectorTurn } from "./director-chat";
import { undoDirectorEdit, useDirector } from "./director-store";
import { useChatDraft } from "./gaps";

/** Zone 4: typed chat with the `director` workspace (no voice, no TTS). */
export function DirectorChat() {
  const chat = useDirector((s) => s.chat);
  const busy = useDirector((s) => s.chatBusy);
  const focus = useDirector((s) => s.focus);
  const undoId = useDirector((s) => s.undo?.id ?? null);
  const draft = useChatDraft((s) => s.draft);
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [chat]);
  useEffect(() => {
    if (focus?.target === "chat") input.current?.focus();
  }, [focus]);
  // A suggested line (fill the gaps): it lands in the box; Nic sends it.
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    // Used once: a remount (or another project) must not bring the line back.
    useChatDraft.setState({ draft: null });
    input.current?.focus();
    input.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [draft]);

  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    void sendDirectorTurn(t);
  };

  return (
    <Card title="Director" hint="Plans shots and edits. Its suggestions fill the shot list, timeline and render plan; nothing runs until you approve it.">
      <div ref={list} className="max-h-[420px] min-h-[160px] space-y-2 overflow-y-auto pr-1">
        {chat.length === 0 && <Empty>Tell the Director what you're making.</Empty>}
        {chat.map((m) => (
          <div key={m.id} className={`flex ${m.role === "nic" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[88%] rounded-[14px] px-3 py-2 text-[13px] leading-relaxed ${m.autoFix ? "border border-dashed border-white/[0.14] bg-transparent font-mono text-[11px] text-ink-3" : m.role === "nic" ? "border border-amber/30 bg-amber/12 text-ink" : "border border-white/[0.08] bg-white/[0.03] text-ink-2"}`}
              title={m.autoFix ? "Sent by the page, not by you: one automatic request for corrected action blocks" : undefined}
            >
              {m.streaming && !m.text ? <Loader2 size={13} className="animate-spin text-ink-3" /> : <p className="whitespace-pre-wrap">{m.text}</p>}
              {m.applied?.map((a) =>
                /\bnot applied\b/.test(a) ? (
                  <p key={a} className="mt-1 flex items-start gap-1 font-mono text-[10px] text-amber-soft">
                    <TriangleAlert size={10} className="mt-0.5 shrink-0" /> {a}
                  </p>
                ) : (
                  <p key={a} className="mt-1 font-mono text-[10px] text-teal-soft">
                    ✓ {a}
                  </p>
                ),
              )}
              {m.undoId && m.undoId === undoId && (
                <button type="button" onClick={() => void undoDirectorEdit()} className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-white/[0.12] px-2 py-0.5 font-mono text-[10px] text-ink-2 hover:bg-white/[0.06]">
                  <Undo2 size={10} /> Undo these edits
                </button>
              )}
              {m.warnings?.map((w) => (
                <p key={w} className="mt-1 flex items-start gap-1 font-mono text-[10px] text-amber-soft">
                  <TriangleAlert size={10} className="mt-0.5 shrink-0" /> plan check: {w}
                </p>
              ))}
              {m.errors?.map((e) => (
                <p key={e} className="mt-1 flex items-start gap-1 font-mono text-[10px] text-amber-soft">
                  <TriangleAlert size={10} className="mt-0.5 shrink-0" /> ignored action: {e}
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>
      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder="Ask the Director…"
          className="field min-h-[44px] resize-none text-[13px]"
          aria-label="Message the Director"
        />
        <button type="submit" disabled={!text.trim() || busy} className="pill-primary !h-10 !w-10 shrink-0 !p-0 disabled:opacity-50" aria-label="Send">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </form>
    </Card>
  );
}
