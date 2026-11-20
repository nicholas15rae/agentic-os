import { useEffect } from "react";
import { gateway } from "@/lib/gateway";
import { isTauri } from "@/lib/platform";
import { useVoice, type VoiceTurn } from "@/features/voice/voice-store";
import { useSettings } from "@/stores/settings";
import { useOs } from "./os-store";
import { startPipelineFeed } from "./pipeline-store";

/**
 * What decides a re-push: the turn count, plus the id / revision / meta of the newest turns, so
 * an answer that streams into its bubble in place (`updateTurn`) is pushed again once it is
 * whole (the key used to be count + last id only, and the mirror kept the first 1.5 s). Pure.
 */
export function syncKey(turns: readonly VoiceTurn[]): string {
  return `${turns.length}|${turns
    .slice(-6)
    .map((t) => `${t.id}:${t.rev ?? 0}:${t.meta ?? ""}`)
    .join(",")}`;
}

/** The threads the phone mirror gets: every turn (system lines included — approvals, cancels,
 * verifier verdicts, build alerts are part of the record), the newest 60 per thread. Pure. */
export function mirrorThreads(turns: readonly VoiceTurn[]): Record<string, VoiceTurn[]> {
  const threads: Record<string, VoiceTurn[]> = {};
  for (const t of turns) (threads[t.thread] ??= []).push(t);
  for (const k of Object.keys(threads)) threads[k] = threads[k].slice(-60);
  return threads;
}

/**
 * Mobile companion readiness:
 *   desktop → pushes its isolated threads to the gateway (`PUT /api/os/threads`)
 *   phone   → pulls them on open and every 30 s (`GET /api/os/threads`)
 * so the Booking / Coder / Tony tabs read the same on both.
 */
export function useOsBoot() {
  useEffect(() => {
    void useOs.getState().load();
    startPipelineFeed();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (isTauri()) {
      let last = "";
      const unsub = useVoice.subscribe((s) => {
        const key = syncKey(s.turns);
        if (key === last) return;
        last = key;
        clearTimeout(timer);
        timer = setTimeout(() => void gateway("/api/os/threads", { method: "PUT", body: JSON.stringify({ threads: mirrorThreads(useVoice.getState().turns) }) }).catch(() => undefined), 1500);
      });
      return () => {
        unsub();
        clearTimeout(timer);
      };
    }
    const pull = () =>
      gateway<{ threads: Record<string, VoiceTurn[]> }>("/api/os/threads")
        .then((r) => useVoice.getState().mergeRemote(Object.values(r.threads ?? {}).flat()))
        .catch(() => undefined);
    void pull();
    const iv = setInterval(pull, 30_000);
    return () => clearInterval(iv);
  }, []);

  const name = useSettings((s) => s.osName);
  useEffect(() => {
    document.title = `${name || "Tony"} · Command Center`;
  }, [name]);

  // Ultra-glass opacity is a CSS variable so every glass-ultra panel follows the slider.
  const glass = useSettings((s) => s.glassOpacity);
  useEffect(() => {
    const a = Math.max(0, Math.min(100, glass)) / 100;
    const root = document.documentElement.style;
    root.setProperty("--ultra-alpha", a.toFixed(3));
    root.setProperty("--ultra-border", (0.04 + a * 0.14).toFixed(3));
    root.setProperty("--ultra-blur", `${(a * 18).toFixed(1)}px`);
  }, [glass]);
}
