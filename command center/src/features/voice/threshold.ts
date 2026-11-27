import { cmd, isTauri } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { ACTIVATION_DB_MAX, ACTIVATION_DB_MIN } from "./vad-gate";

/**
 * Where the activation threshold lives (Phase 2 Part B, D10): Rust os.json `voice.activationDb`
 * is authoritative on the desktop and `settings.vad.activationDb` mirrors it; on the phone the
 * setting is the only copy. A slider move updates the local value at once (the gate uses it on
 * the very next audio frame) and writes os.json 250 ms after the last move.
 */

const clampDb = (db: number) => Math.round(Math.max(ACTIVATION_DB_MIN, Math.min(ACTIVATION_DB_MAX, db)));

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function setActivationDb(db: number): void {
  if (!Number.isFinite(db)) return;
  const v = clampDb(db);
  const s = useSettings.getState();
  if (s.vad.activationDb !== v) s.set({ vad: { ...s.vad, activationDb: v } });
  if (!isTauri()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void Promise.resolve()
      .then(() => cmd("os_config_update", { patch: { voice: { activationDb: v, activationDbSet: true } } }))
      .catch(() => undefined);
  }, 250);
}

/**
 * Desktop startup. When os.json holds a gate the webview wrote (`activationDbSet`), adopt it.
 * Otherwise Rust only has its serde default (-44 dB, e.g. an os.json from before Part B), so the
 * local value (the v7 migration of the old sensitivity) wins and is written up once.
 * No-op on the phone.
 */
export async function syncThresholdFromOs(): Promise<void> {
  if (!isTauri()) return;
  try {
    const cfg = await cmd("os_config_get");
    const db = cfg?.voice?.activationDb;
    const s = useSettings.getState();
    if (cfg?.voice?.activationDbSet !== true || typeof db !== "number" || !Number.isFinite(db)) {
      const local = clampDb(s.vad?.activationDb ?? db ?? -44);
      await cmd("os_config_update", { patch: { voice: { activationDb: local, activationDbSet: true } } });
      return;
    }
    if (s.vad?.activationDb !== db) s.set({ vad: { ...s.vad, activationDb: clampDb(db) } });
  } catch {
    /* keep the local value */
  }
}
