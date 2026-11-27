import { useRef, useState } from "react";
import { BookmarkCheck, BookmarkPlus, Check, Copy, Loader2, Mic, Square, Volume2 } from "lucide-react";
import { Select } from "@/components/ui";
import { useToasts } from "@/features/reminders/notify";
import { expectedVoice, speak } from "./audio";
import { pressHandlers } from "./press";
import { LANGUAGES } from "./languages";
import { useHub } from "./store";

export const toastError = (title: string, e: unknown) => useToasts.getState().push({ title, body: e instanceof Error ? e.message : String(e), tone: "error" });

export function LangSelect({ value, onChange, auto, label, className = "" }: { value: string; onChange: (v: string) => void; auto?: boolean; label: string; className?: string }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={`!h-10 !py-1 fs-13 ${className}`}>
      {auto && <option value="auto">Auto-detect</option>}
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.name}
          {l.kokoro ? "" : " · browser voice"}
        </option>
      ))}
    </Select>
  );
}

export function PlayButton({ text, lang, size = 14, label = "Play audio" }: { text: string; lang: string; size?: number; label?: string }) {
  const [busy, setBusy] = useState(false);
  const setEngine = useHub((s) => s.setEngine);
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} · ${expectedVoice(lang)}`}
      className="pill-glass !h-8 !w-8 !p-0"
      onClick={async () => {
        setBusy(true);
        try {
          setEngine(await speak(text, lang));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 size={size} className="animate-spin" /> : <Volume2 size={size} />}
    </button>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy"
      title="Copy"
      className="pill-glass !h-8 !w-8 !p-0"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

export function SaveButton({ saved, onSave }: { saved: boolean; onSave: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={saved || busy}
      aria-label={saved ? "Saved to Library" : "Save to Library"}
      title={saved ? "Saved to Library" : "Save to Library"}
      className={`pill-glass !h-8 !w-8 !p-0 ${saved ? "!text-teal" : ""}`}
      onClick={async () => {
        setBusy(true);
        try {
          await onSave();
        } catch (e) {
          toastError("Couldn't save", e);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : saved ? <BookmarkCheck size={14} /> : <BookmarkPlus size={14} />}
    </button>
  );
}

export function EngineBadge() {
  const e = useHub((s) => s.lastEngine);
  if (!e) return null;
  return (
    <span role="status" title={e.reason ? `Fell back: ${e.reason}` : undefined} className={`max-w-[60vw] truncate rounded-full border bg-[rgba(11,13,17,0.6)] px-2 py-0.5 font-mono fs-10 ${e.fallback ? "border-amber/40 text-amber-light" : "border-teal/40 text-teal"}`}>
      voice: {e.label}
      {e.reason ? ` — ${e.reason}` : ""}
    </span>
  );
}

/**
 * The big one-tap record button: tap to start, tap again to stop (hold-to-talk also works:
 * press-and-hold starts, release stops once it's been held over 400 ms).
 */
export function RecordButton({
  label,
  sub,
  recording,
  busy,
  level,
  onStart,
  onStop,
  tone = "amber",
  big = false,
}: {
  label: string;
  sub?: string;
  recording: boolean;
  busy: boolean;
  level: number;
  onStart: () => void;
  onStop: () => void;
  tone?: "amber" | "teal";
  big?: boolean;
}) {
  // Tap / hold handling (press.ts): refs, not state, so the click after a starting tap can't
  // stop a recording whose mic is still opening. Latest props are read through a ref.
  const live = useRef({ recording, busy, onStart, onStop });
  live.current = { recording, busy, onStart, onStop };
  const h = useRef(pressHandlers({ recording: () => live.current.recording, busy: () => live.current.busy, onStart: () => live.current.onStart(), onStop: () => live.current.onStop() })).current;
  // Solid dark backing under the tint: these sit on the wallpaper and must read in full sun.
  const ring =
    tone === "amber"
      ? "border-amber/60 bg-[linear-gradient(rgba(255,122,47,0.2),rgba(255,122,47,0.2)),rgba(11,13,17,0.78)] text-amber-light"
      : "border-teal/60 bg-[linear-gradient(rgba(0,229,195,0.16),rgba(0,229,195,0.16)),rgba(11,13,17,0.78)] text-teal-soft";
  return (
    <button
      type="button"
      aria-pressed={recording}
      aria-label={recording ? `Stop — ${label}` : label}
      disabled={busy && !recording}
      onPointerDown={() => h.down()}
      onPointerUp={() => h.up()}
      onPointerCancel={() => h.cancel()}
      onClick={(e) => h.click(e.detail)}
      className={`relative flex w-full select-none items-center justify-center gap-3 r-20 border px-4 font-semibold backdrop-blur-md transition-colors touch-none ${big ? "min-h-24 text-lg" : "min-h-16 fs-15"} ${
        recording ? "border-alert/70 bg-[linear-gradient(rgba(255,90,95,0.25),rgba(255,90,95,0.25)),rgba(11,13,17,0.8)] text-ink" : ring
      } disabled:opacity-50`}
      style={recording ? { boxShadow: `0 0 0 ${2 + level * 14}px rgba(255,90,95,0.18)` } : undefined}
    >
      {busy && !recording ? <Loader2 className="animate-spin" size={big ? 26 : 20} /> : recording ? <Square size={big ? 24 : 18} /> : <Mic size={big ? 26 : 20} />}
      <span className="flex flex-col items-start leading-tight">
        <span>{recording ? "Listening… tap to stop" : label}</span>
        {sub && !recording && <span className="fs-11 font-normal opacity-75">{sub}</span>}
      </span>
    </button>
  );
}
