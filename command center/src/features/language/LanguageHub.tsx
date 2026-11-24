import { useEffect } from "react";
import { BookOpen, GraduationCap, Languages } from "lucide-react";
import { langApi } from "./api";
import { stopSpeaking } from "./audio";
import { LearnView } from "./LearnView";
import { LibraryView } from "./LibraryView";
import { EngineBadge } from "./parts";
import { useHub, type HubView } from "./store";
import { TranslateView } from "./TranslateView";

const VIEWS: { id: HubView; label: string; short: string; icon: typeof Languages }[] = [
  { id: "translate", label: "Live Translate", short: "Translate", icon: Languages },
  { id: "learn", label: "Learn & Practice", short: "Practice", icon: GraduationCap },
  { id: "library", label: "Library", short: "Library", icon: BookOpen },
];

/**
 * Language Hub: live translator, tutor and phrase library. Mounted by the Language section
 * (desktop + phone PWA) and the Mobile HUD's Language tab (`compact`). Loads the library once on
 * mount; on unmount stops playback and releases the on-demand Whisper sidecar — nothing keeps
 * running while the Hub is closed.
 */
export function LanguageHub({ compact = false }: { compact?: boolean }) {
  const view = useHub((s) => s.view);
  const setPrefs = useHub((s) => s.setPrefs);
  const libCount = useHub((s) => s.library.length);
  const loaded = useHub((s) => s.libraryLoaded);
  useEffect(() => {
    void useHub.getState().loadAll();
    return () => {
      stopSpeaking();
      langApi.release();
    };
  }, []);

  return (
    <div className={compact ? "space-y-3 pt-1" : "mx-auto h-full w-full max-w-6xl space-y-4 overflow-y-auto px-4 pb-32 pt-1 md:px-6 md:pb-8"}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="well flex w-full rounded-full p-1 sm:w-auto" role="tablist" aria-label="Language Hub views">
          {VIEWS.map(({ id, label, short, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-label={label}
              aria-selected={view === id}
              onClick={() => setPrefs({ view: id })}
              className={`flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors sm:flex-none sm:px-4 ${
                view === id ? "bg-amber/20 text-amber-light" : "text-ink-2 hover:text-ink"
              }`}
            >
              <Icon size={15} />
              {/* Phones get the one-word label so the three pills stay on one line. */}
              <span className={compact ? "text-[12px]" : "hidden sm:inline"}>{compact ? short : label}</span>
              {!compact && <span className="sm:hidden">{short}</span>}
              {id === "library" && loaded && <span className="font-mono text-[10px] text-ink-3">{libCount}</span>}
            </button>
          ))}
        </div>
        <div className="ml-auto">
          <EngineBadge />
        </div>
      </div>
      <div role="tabpanel">
        {view === "translate" && <TranslateView compact={compact} />}
        {view === "learn" && <LearnView compact={compact} />}
        {view === "library" && <LibraryView compact={compact} />}
      </div>
    </div>
  );
}
