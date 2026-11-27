import { cmd, isTauri } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import type { Reminder } from "./types";

/**
 * Windows OS-alarm fallback (alarm.rs): a saved alarm / reminder also rings through Task
 * Scheduler when the app is closed. The in-app scheduler fires first and cancels it, so it
 * never rings twice. Desktop only, best effort (never throws), behind `reminders.osFallback`.
 */
const enabled = () => isTauri() && useSettings.getState().reminders.osFallback;

/** Kinds that ring (countdowns and mirrored calendar events don't). */
export const ringsOnOs = (r: Pick<Reminder, "kind" | "source">) => (r.kind === "alarm" || r.kind === "reminder") && r.source !== "gcal";

/** The Windows alarm rings this long after the due time, so a running app (10 s tick) always
 * rings first and cancels it. */
export const OS_GRACE_MS = 20_000;

/** True when the OS alarm was registered (or replaced: one task per reminder id). */
export async function scheduleOsAlarm(id: string, title: string, dueAt: number): Promise<boolean> {
  if (!enabled()) return false;
  return cmd("alarm_os_schedule", { id, title: title.slice(0, 120), dueAtMs: Math.round(dueAt) + OS_GRACE_MS })
    .then(() => {
      writeTasked({ ...readTasked(), [id]: dueAt });
      return true;
    })
    .catch(() => false);
}

export async function cancelOsAlarm(id: string): Promise<void> {
  if (!isTauri()) return;
  const t = readTasked();
  if (id in t) {
    delete t[id];
    writeTasked(t);
  }
  await cmd("alarm_os_cancel", { id }).catch(() => undefined);
}

/** Startup cleanup: drop OS alarms whose reminder is gone, fired or dismissed. */
export async function pruneOsAlarms(liveIds: string[]): Promise<void> {
  if (!isTauri()) return;
  await cmd("alarm_os_prune", { liveIds }).catch(() => undefined);
}

/** Alarms saved while the gateway was down live only in Task Scheduler: keep them through `pruneOsAlarms`. */
const LOCAL_KEY = "cc.osAlarms.local";

function readLocal(): { id: string; dueAt: number }[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x?.id === "string" && typeof x?.dueAt === "number") : [];
  } catch {
    return [];
  }
}

export function rememberLocalAlarm(id: string, dueAt: number) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify([...readLocal().filter((x) => x.dueAt > Date.now()), { id, dueAt }].slice(-200)));
  } catch {
    // storage unavailable: the alarm still rings, a later prune may drop it
  }
}

/** Ids of this-PC-only alarms that are still ahead. */
export const localAlarmIds = () => readLocal().filter((x) => x.dueAt > Date.now()).map((x) => x.id);

// ── What this PC registered ─────────────────────────────────────────────────
// reminder id → the dueAt its Windows task was registered for (kept across runs), so a running
// app can follow changes made anywhere (the phone, another client, a calendar sync).

const TASKED_KEY = "cc.osAlarms.tasked";
/** Past the task's trigger (due + OS_GRACE_MS) by this much, its toast has shown. */
const RANG_SLACK_MS = 15_000;

function readTasked(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(TASKED_KEY) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, d]) => typeof d === "number")) as Record<string, number>;
  } catch {
    return {};
  }
}

function writeTasked(t: Record<string, number>) {
  try {
    localStorage.setItem(TASKED_KEY, JSON.stringify(Object.fromEntries(Object.entries(t).slice(-500))));
  } catch {
    // storage unavailable: changes made elsewhere are then only cleaned up by the startup prune
  }
}

/** The dueAt this PC's Windows task for `id` was registered for, if any. */
export const taskedDueAt = (id: string): number | undefined => readTasked()[id];

/** Pure: Windows has already shown this alarm (its task was set for this dueAt and has run by
 * now), so the in-app scheduler must not ring it again (the app was closed, then reopened). */
export function osAlarmRang(taskedDue: number | undefined, dueAt: number, now: number): boolean {
  return taskedDue === dueAt && now > dueAt + OS_GRACE_MS + RANG_SLACK_MS;
}

type Live = Pick<Reminder, "kind" | "source" | "dueAt" | "title" | "dismissed" | "firedAt"> & { id: string };

/**
 * Pure: bring this PC's Windows tasks in line with the shared reminders after a change made
 * anywhere. A reminder deleted, dismissed or fired (by any device) loses its task; one whose
 * dueAt moved (snoozed on the phone, edited, a calendar sync) is re-registered there. Alarms
 * saved while the gateway was down (`localIds`) aren't in the collection and are left alone.
 */
export function osAlarmFixes(tasked: Record<string, number>, reminders: Live[], now: number, localIds: string[] = []) {
  const byId = new Map(reminders.map((r) => [r.id, r]));
  const local = new Set(localIds);
  const cancel: string[] = [];
  const move: { id: string; title: string; dueAt: number }[] = [];
  for (const [id, due] of Object.entries(tasked)) {
    const r = byId.get(id);
    if (!r) {
      if (!local.has(id)) cancel.push(id);
    } else if (r.dismissed || r.firedAt || !ringsOnOs(r)) cancel.push(id);
    else if (r.dueAt !== due) {
      // Moved into the past (or too close to register): the in-app scheduler handles it.
      if (r.dueAt > now + 10_000) move.push({ id, title: r.title, dueAt: r.dueAt });
      else cancel.push(id);
    }
  }
  return { cancel, move };
}

/** Apply `osAlarmFixes` to this PC's tasks (desktop only, best effort). */
export function reconcileOsAlarms(reminders: Live[]): void {
  if (!isTauri()) return;
  const { cancel, move } = osAlarmFixes(readTasked(), reminders, Date.now(), localAlarmIds());
  for (const id of cancel) void cancelOsAlarm(id);
  for (const m of move) void scheduleOsAlarm(m.id, m.title, m.dueAt).then((ok) => (ok ? undefined : cancelOsAlarm(m.id)));
}
