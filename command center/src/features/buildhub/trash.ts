import { create } from "zustand";
import { xcmd } from "@/lib/native-ext";
import { useToasts } from "@/features/reminders/notify";
import { allSurfaceStores, type RemovedTile } from "@/core/widgets/layout-store";
import { useMyApps, type MountedApp } from "@/features/myapps/store";
import type { DeleteReport, TrashEntry } from "./types";

/** Days a deleted build stays recoverable (Rust `trash::RETENTION_DAYS`). */
export const TRASH_DAYS = 30;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The Trash list (Staging hub → Trash tab). */
export const useTrash = create<{ entries: TrashEntry[]; loaded: boolean; error: string | null; load: () => Promise<void> }>((set) => ({
  entries: [],
  loaded: false,
  error: null,
  load: async () => {
    try {
      set({ entries: await xcmd("trash_list"), loaded: true, error: null });
    } catch (e) {
      set({ error: msg(e), loaded: true });
    }
  },
}));

/** "in 29 days" / "today". Pure. */
export function expiresIn(e: Pick<TrashEntry, "expiresAt">, now = Date.now()): string {
  const days = Math.ceil((e.expiresAt - now) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "in 1 day" : `in ${days} days`;
}

/** What a deleted build had on screen (its tiles on every page and per-mode layout, its My Apps pin), so a restore puts it back. */
export interface RemovedUi {
  tiles: RemovedTile[];
  pin?: MountedApp;
}

/** Take a build's promoted tiles off every page and its pin off My Apps; returns what was removed. */
export function removeBuildUi(buildId: string): RemovedUi {
  const tiles = allSurfaceStores().flatMap((st) => st.getState().removeWhere((i) => (i.config as { buildId?: unknown } | undefined)?.buildId === buildId));
  const pin = useMyApps.getState().apps.find((a) => a.kind === "build" && a.ref === buildId);
  if (pin) useMyApps.getState().unmount(pin.id);
  return { tiles, pin };
}

function putBackUi(ui: RemovedUi) {
  // Older saves have no surface (home) and no variant (the live layout).
  if (ui.tiles.length) for (const st of allSurfaceStores()) st.getState().putBack(ui.tiles.filter((t) => (t.surface ?? "home") === st.getState().surface));
  const pin = ui.pin;
  if (pin) useMyApps.setState((s) => (s.apps.some((a) => a.id === pin.id) ? s : { apps: [...s.apps, pin] }));
}

// What each trash entry removed from the screen, kept per viewer so the Trash tab's Restore can
// put it back too (not only the toast's Undo). Best effort: storage can be unavailable.
const UI_KEY = "cc.trashUi";
type UiMap = Record<string, RemovedUi & { at: number }>;
function readUi(): UiMap {
  try {
    const v = JSON.parse(localStorage.getItem(UI_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as UiMap) : {};
  } catch {
    return {};
  }
}
function writeUi(m: UiMap) {
  try {
    const cutoff = Date.now() - (TRASH_DAYS + 1) * 86_400_000;
    localStorage.setItem(UI_KEY, JSON.stringify(Object.fromEntries(Object.entries(m).filter(([, v]) => v.at > cutoff))));
  } catch {
    /* per-viewer convenience only */
  }
}
/** Remember what `trashId`'s delete took off the screen. */
export function rememberUi(trashId: string, ui: RemovedUi) {
  if (!ui.tiles.length && !ui.pin) return;
  writeUi({ ...readUi(), [trashId]: { ...ui, at: Date.now() } });
}
function takeUi(trashId: string): RemovedUi | undefined {
  const m = readUi();
  const v = m[trashId];
  if (v) {
    delete m[trashId];
    writeUi(m);
  }
  return v;
}

/** Forget the remembered screen state of an entry deleted for good. */
export function forgetUi(trashId: string) {
  takeUi(trashId);
}

/** Undo a delete from its trash id: folders, card or runner row, and its tiles / pin. */
export async function restoreFromTrash(trashId: string, ui?: RemovedUi): Promise<boolean> {
  try {
    const e = await xcmd("trash_restore", { trashId });
    const saved = takeUi(trashId);
    putBackUi(ui ?? saved ?? { tiles: [] });
    // A restored runner is back in task_list: refresh the Build Runners list now.
    if (e.kind === "runner" || e.taskId) void import("@/features/os/pipeline-store").then((m) => m.hydrateFromStore()).catch(() => undefined);
    void useTrash.getState().load();
    useToasts.getState().push({ title: `Restored “${e.title}”`, tone: "info" });
    return true;
  } catch (e) {
    useToasts.getState().push({ title: "Restore", body: msg(e), tone: "error" });
    return false;
  }
}

/** The toast after a delete: what moved to the Trash (only when something did), with Undo. */
export function deletedToast(title: string, r: DeleteReport, ui: RemovedUi = { tiles: [] }) {
  const trashId = r.trashId;
  const left = r.left?.length ? `couldn't move ${r.left.length} folder(s) (in use) — left in place` : null;
  const parts = [r.aborted ? "aborted first" : null, trashId ? `moved to the Trash for ${TRASH_DAYS} days` : "removed (nothing to restore)", left, r.kept ? `kept ${r.kept}` : null].filter(Boolean);
  if (trashId) rememberUi(trashId, ui);
  useToasts.getState().push({
    title: `Deleted “${title}”`,
    body: parts.join(" · "),
    tone: left ? "warn" : "info",
    actions: trashId ? [{ label: "Undo", run: () => void restoreFromTrash(trashId, ui) }] : undefined,
  });
  void useTrash.getState().load();
}
