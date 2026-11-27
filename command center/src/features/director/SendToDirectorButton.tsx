import { useState } from "react";
import { Clapperboard, Loader2 } from "lucide-react";
import { isTauri } from "@/lib/platform";
import type { DirectorHandoff } from "./contract";
import { sendToDirector } from "./handoff";

/** "Send to Director Suite" (Brainstorm / Play Place): creates a project from `handoff()` and opens it. */
export function SendToDirectorButton({ handoff, disabled, className = "" }: { handoff: () => DirectorHandoff; disabled?: boolean; className?: string }) {
  const [busy, setBusy] = useState(false);
  const desktop = isTauri();
  return (
    <button
      type="button"
      disabled={disabled || busy || !desktop}
      onClick={async () => {
        setBusy(true);
        try {
          await sendToDirector(handoff());
        } finally {
          setBusy(false);
        }
      }}
      className={`pill-glass !h-9 text-xs disabled:opacity-50 ${className}`}
      title={desktop ? "Open a Director Suite project with this as its brief" : "The Director Suite needs the desktop app"}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Clapperboard size={13} />} Send to Director Suite
    </button>
  );
}
